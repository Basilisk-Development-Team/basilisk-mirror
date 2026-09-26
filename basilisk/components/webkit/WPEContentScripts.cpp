/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WebKitContentView.h"
#include "WPEHost.h"
#include "nsHashPropertyBag.h"
#include <jsc/jsc.h>

namespace {
const char* const kContentWorld = "basilisk-content";
const char* const kMessagingBootstrap = R"JS(
if (!globalThis.browserContent) {
  const listeners = new Set();
  Object.defineProperty(globalThis, 'browserContent', {value: Object.freeze({
    sendMessage(value) {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') throw new TypeError('Message must be JSON serializable');
      window.webkit.messageHandlers.basilisk.postMessage(json);
    },
    addMessageListener(fn) { listeners.add(fn); },
    removeMessageListener(fn) { listeners.delete(fn); },
    _dispatch(json) { const value = JSON.parse(json); for (const fn of listeners) fn(value); }
  })});
}
)JS";
struct ScriptReply {
  RefPtr<WebKitContentView> owner;
  uint32_t id;
};
}

void WebKitContentView::EnsureMessaging()
{
  if (mMessaging) return;
  auto* manager = webkit_web_view_get_user_content_manager(mHost->webView);
  g_signal_connect(manager, "script-message-received::basilisk", G_CALLBACK(+[](WebKitUserContentManager*,
    JSCValue* value, gpointer data) {
      if (!jsc_value_is_string(value)) return;
      char* json = jsc_value_to_string(value);
      if (json && strlen(json) <= 1024 * 1024) {
        RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
        info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), nsDependentCString(json));
        static_cast<WebKitContentView*>(data)->Notify("content-view-message", static_cast<nsIWritablePropertyBag2*>(info));
      }
      g_free(json);
    }), this);
  webkit_user_content_manager_register_script_message_handler(manager, "basilisk", kContentWorld);
  mMessaging = true;
}

void WebKitContentView::CancelScripts()
{
  if (mScriptCancellation) {
    g_cancellable_cancel(mScriptCancellation);
    g_clear_object(&mScriptCancellation);
  }
}

NS_IMETHODIMP WebKitContentView::ExecuteScript(uint32_t id, const nsACString& source)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(source.Length() <= 1024 * 1024, NS_ERROR_INVALID_ARG);
  EnsureMessaging();
  if (!mScriptCancellation) mScriptCancellation = g_cancellable_new();
  auto* reply = new ScriptReply{this, id};
  nsAutoCString body(kMessagingBootstrap);
  body.Append(source);
  webkit_web_view_call_async_javascript_function(mHost->webView, body.get(), body.Length(), nullptr,
    kContentWorld, "basilisk-content-script", mScriptCancellation,
    [](GObject* object, GAsyncResult* result, gpointer data) {
      auto* reply = static_cast<ScriptReply*>(data);
      GError* error = nullptr;
      JSCValue* value = webkit_web_view_call_async_javascript_function_finish(WEBKIT_WEB_VIEW(object), result, &error);
      char* json = value && !jsc_value_is_undefined(value) ? jsc_value_to_json(value, 0) : g_strdup("null");
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), reply->id);
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), nsDependentCString(json ? json : "null"));
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(
        error ? error->message : !json ? "Result is not JSON serializable" : ""));
      reply->owner->Notify("content-view-script-result", static_cast<nsIWritablePropertyBag2*>(info));
      g_free(json);
      g_clear_object(&value);
      g_clear_error(&error);
      delete reply;
    }, reply);
  return NS_OK;
}
