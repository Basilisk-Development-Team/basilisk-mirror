/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WebKitContentView.h"
#include "WPEHost.h"
#include "nsHashPropertyBag.h"
#include <jsc/jsc.h>

namespace {
const char* const kContentWorld = "basilisk-content";
struct ScriptReply {
  RefPtr<WebKitContentView> owner;
  uint32_t id;
};
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
  if (!mScriptCancellation) mScriptCancellation = g_cancellable_new();
  auto* reply = new ScriptReply{this, id};
  nsAutoCString body(source);
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
