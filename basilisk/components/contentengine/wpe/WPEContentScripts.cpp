/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEContentView.h"
#include "WPEHost.h"
#include "WPERuntime.h"
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
  RefPtr<WPEContentView> owner;
  uint32_t id;
};
}

void WPEContentView::EnsureMessaging()
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
        static_cast<WPEContentView*>(data)->Notify("content-view-message", static_cast<nsIWritablePropertyBag2*>(info));
      }
      g_free(json);
    }), this);
  webkit_user_content_manager_register_script_message_handler(manager, "basilisk", kContentWorld);
  mMessaging = true;
}

void WPEContentView::CancelScripts()
{
  if (mScriptCancellation) {
    g_cancellable_cancel(mScriptCancellation);
    g_clear_object(&mScriptCancellation);
  }
}

NS_IMETHODIMP WPEContentView::ExecuteScript(uint32_t id, const nsACString& source)
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

NS_IMETHODIMP WPEContentView::InsertCSS(const nsACString& identifier, const nsACString& source)
{ return InsertCSSWithOptions(identifier, source, false); }

NS_IMETHODIMP WPEContentView::InsertCSSWithOptions(const nsACString& identifier, const nsACString& source, bool allFrames)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(!identifier.IsEmpty() && identifier.Length() <= 256 && source.Length() <= 1024 * 1024,
                 NS_ERROR_INVALID_ARG);
  RemoveCSS(identifier);
  if (!mStyleSheets) mStyleSheets = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
    +[](gpointer value) { webkit_user_style_sheet_unref(static_cast<WebKitUserStyleSheet*>(value)); });
  nsAutoCString id(identifier);
  nsAutoCString css(source);
  auto* sheet = webkit_user_style_sheet_new_for_world(css.get(), allFrames ? WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES : WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
    WEBKIT_USER_STYLE_LEVEL_USER, kContentWorld, nullptr, nullptr);
  webkit_user_content_manager_add_style_sheet(webkit_web_view_get_user_content_manager(mHost->webView), sheet);
  g_hash_table_insert(mStyleSheets, g_strdup(id.get()), sheet);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::RemoveCSS(const nsACString& identifier)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  nsAutoCString id(identifier);
  auto* sheet = mStyleSheets ? static_cast<WebKitUserStyleSheet*>(g_hash_table_lookup(mStyleSheets, id.get())) : nullptr;
  if (sheet) {
    webkit_user_content_manager_remove_style_sheet(webkit_web_view_get_user_content_manager(mHost->webView), sheet);
    g_hash_table_remove(mStyleSheets, id.get());
  }
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::RegisterScript(const nsACString& identifier, const nsACString& source)
{ return RegisterScriptWithOptions(identifier, source, SCRIPT_DOCUMENT_END, false); }

NS_IMETHODIMP WPEContentView::RegisterScriptWithOptions(const nsACString& identifier, const nsACString& source, uint32_t runAt, bool allFrames)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(!identifier.IsEmpty() && identifier.Length() <= 256 && source.Length() <= 1024 * 1024,
                 NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(runAt <= SCRIPT_DOCUMENT_IDLE, NS_ERROR_INVALID_ARG);
  UnregisterScript(identifier);
  EnsureMessaging();
  if (!mUserScripts) mUserScripts = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
    +[](gpointer value) { webkit_user_script_unref(static_cast<WebKitUserScript*>(value)); });
  nsAutoCString id(identifier);
  nsAutoCString code(kMessagingBootstrap);
  if (runAt == SCRIPT_DOCUMENT_IDLE) code.AppendLiteral("\nsetTimeout(() => {\n");
  code.AppendLiteral("\n(async function(){\n");
  code.Append(source);
  code.AppendLiteral("\n})();");
  if (runAt == SCRIPT_DOCUMENT_IDLE) code.AppendLiteral("\n}, 0);");
  auto* script = webkit_user_script_new_for_world(code.get(), allFrames ? WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES : WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
    runAt == SCRIPT_DOCUMENT_START ? WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START : WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_END,
    kContentWorld, nullptr, nullptr);
  webkit_user_content_manager_add_script(webkit_web_view_get_user_content_manager(mHost->webView), script);
  g_hash_table_insert(mUserScripts, g_strdup(id.get()), script);
  return NS_OK;
}

nsresult WPEContentView::SendFrameOperation(uint32_t id, const char* name, GVariant* parameters)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  if (!mScriptCancellation) mScriptCancellation = g_cancellable_new();
  auto* reply = new ScriptReply{this, id};
  webkit_web_view_send_message_to_page(mHost->webView, webkit_user_message_new(name, parameters), mScriptCancellation,
    [](GObject* object, GAsyncResult* result, gpointer data) {
      auto* reply = static_cast<ScriptReply*>(data);
      GError* error = nullptr;
      auto* message = webkit_web_view_send_message_to_page_finish(WEBKIT_WEB_VIEW(object), result, &error);
      const char *json = "null", *failure = error ? error->message : "Invalid frame reply";
      auto* parameters = message ? webkit_user_message_get_parameters(message) : nullptr;
      if (parameters && g_variant_is_of_type(parameters, G_VARIANT_TYPE("(ss)")))
        g_variant_get(parameters, "(&s&s)", &json, &failure);
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), reply->id);
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), nsDependentCString(json));
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(failure));
      reply->owner->Notify("content-view-script-result", static_cast<nsIWritablePropertyBag2*>(info));
      g_clear_object(&message); g_clear_error(&error); delete reply;
    }, reply);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GetFrames(uint32_t id)
{ return SendFrameOperation(id, "basilisk:frames", nullptr); }
NS_IMETHODIMP WPEContentView::ExecuteFrameScript(uint32_t id, const nsACString& frame, const nsACString& source)
{
  NS_ENSURE_TRUE(!frame.IsEmpty() && frame.Length() <= 128 && source.Length() <= 1024 * 1024, NS_ERROR_INVALID_ARG);
  nsAutoCString token(frame), script(source);
  return SendFrameOperation(id, "basilisk:execute", g_variant_new("(uss)", id, token.get(), script.get()));
}
NS_IMETHODIMP WPEContentView::ExecuteWorldScript(uint32_t id, const nsACString& frame,
  const nsACString& world, const nsACString& source, bool globalScope)
{
  NS_ENSURE_TRUE(!frame.IsEmpty() && frame.Length() <= 128 && !world.IsEmpty() &&
    world.Length() <= 128 && source.Length() <= 1024 * 1024, NS_ERROR_INVALID_ARG);
  nsAutoCString token(frame), key(world), script(source);
  return SendFrameOperation(id, "basilisk:world-execute",
    g_variant_new("(usssb)", id, token.get(), key.get(), script.get(), globalScope));
}
NS_IMETHODIMP WPEContentView::PrepareWorld(uint32_t id, const nsACString& world)
{
  NS_ENSURE_TRUE(!world.IsEmpty() && world.Length() <= 128, NS_ERROR_INVALID_ARG);
  nsAutoCString key(world);
  if (!mExecutionWorlds)mExecutionWorlds=g_hash_table_new_full(g_str_hash,g_str_equal,g_free,nullptr);
  if (!g_hash_table_contains(mExecutionWorlds,key.get())) {
    g_hash_table_add(mExecutionWorlds,g_strdup(key.get()));WPERetainExecutionWorld(key.get());
  }
  return SendFrameOperation(id, "basilisk:world-prepare", g_variant_new("(s)", key.get()));
}
NS_IMETHODIMP WPEContentView::ReleaseWorld(uint32_t id, const nsACString& world)
{
  NS_ENSURE_TRUE(!world.IsEmpty() && world.Length() <= 128, NS_ERROR_INVALID_ARG);
  nsAutoCString key(world);
  if (mExecutionWorlds && g_hash_table_remove(mExecutionWorlds,key.get()))WPEReleaseExecutionWorld(key.get());
  return SendFrameOperation(id, "basilisk:world-release", g_variant_new("(s)", key.get()));
}
NS_IMETHODIMP WPEContentView::RegisterWorldScript(const nsACString& identifier,
  const nsACString& world, const nsACString& source, uint32_t runAt, bool allFrames)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  NS_ENSURE_TRUE(!world.IsEmpty() && world.Length() <= 128 && source.Length() <= 1024 * 1024 &&
    runAt <= SCRIPT_DOCUMENT_END && !identifier.IsEmpty() && identifier.Length() <= 256, NS_ERROR_INVALID_ARG);
  nsresult rv = UnregisterScript(identifier); NS_ENSURE_SUCCESS(rv, rv);
  if (!mUserScripts) mUserScripts = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
    reinterpret_cast<GDestroyNotify>(webkit_user_script_unref));
  nsAutoCString key("basilisk-legacy-"); key.Append(world);
  nsAutoCString code;
  code.Append(source);
  auto* script = webkit_user_script_new_for_world(code.get(), allFrames ? WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES : WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
    runAt == SCRIPT_DOCUMENT_START ? WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START : WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_END,
    key.get(), nullptr, nullptr);
  webkit_user_content_manager_add_script(webkit_web_view_get_user_content_manager(mHost->webView), script);
  nsAutoCString id(identifier); g_hash_table_insert(mUserScripts, g_strdup(id.get()), script);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::UnregisterScript(const nsACString& identifier)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed, NS_ERROR_NOT_AVAILABLE);
  nsAutoCString id(identifier);
  auto* script = mUserScripts ? static_cast<WebKitUserScript*>(g_hash_table_lookup(mUserScripts, id.get())) : nullptr;
  if (script) {
    webkit_user_content_manager_remove_script(webkit_web_view_get_user_content_manager(mHost->webView), script);
    g_hash_table_remove(mUserScripts, id.get());
  }
  return NS_OK;
}
