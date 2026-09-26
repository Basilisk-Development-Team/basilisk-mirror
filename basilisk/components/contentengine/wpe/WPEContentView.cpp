/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEContentView.h"
#include "mozilla/ModuleUtils.h"
#include "nsString.h"
#include "nsGlobalWindow.h"
#include "nsIWidget.h"
#include "nsThreadUtils.h"
#include "nsNetUtil.h"
#include "nsIURI.h"
#include "nsHashPropertyBag.h"
#include "mozcontainer.h"
#include "WPEHost.h"
#include "WPEStorage.h"
#include "WPEGtk.h"

NS_IMPL_ISUPPORTS(WPEContentView, nsIWebContentView)
WPEContentView::~WPEContentView() { Destroy(); }
NS_IMETHODIMP WPEContentView::Attach(mozIDOMWindowProxy* window, nsIContentViewObserver* listener)
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  NS_ENSURE_ARG_POINTER(window);
  NS_ENSURE_ARG_POINTER(listener);
  NS_ENSURE_TRUE(!mHost && !mDestroyed, NS_ERROR_ALREADY_INITIALIZED);
  auto* chrome = nsGlobalWindow::Cast(window);
  NS_ENSURE_TRUE(chrome->IsChromeWindow(), NS_ERROR_DOM_SECURITY_ERR);
  nsCOMPtr<nsIWidget> widget = chrome->GetMainWidget();
  NS_ENSURE_TRUE(widget, NS_ERROR_NOT_AVAILABLE);
  auto* native = static_cast<GdkWindow*>(widget->GetNativeData(NS_NATIVE_WIDGET));
  NS_ENSURE_TRUE(native, NS_ERROR_NOT_AVAILABLE);
  gpointer container = nullptr;
  gdk_window_get_user_data(native, &container);
  // Without client-side decorations nsWindow draws on its GtkWindow and the
  // MozContainer is its windowless child. With CSD it owns the GdkWindow itself.
  if (container && GTK_IS_WINDOW(container))
    container = gtk_bin_get_child(GTK_BIN(container));
  NS_ENSURE_TRUE(container && IS_MOZ_CONTAINER(container), NS_ERROR_NOT_AVAILABLE);
  mContainer = MOZ_CONTAINER(container);
  mListener = listener;
  mPrivate = chrome->IsPrivateBrowsing();
  if (mInspectorView) {
    mHost = wpe_host_for_view(mInspectorView);
    NS_ENSURE_TRUE(mHost, NS_ERROR_FAILURE);
    return Mount(native);
  }
  // A chrome window retains its session even when its last WPE tab closes.
  // Normal windows share profile storage; private windows never open it.
  auto* session = static_cast<WebKitNetworkSession*>(
    g_object_get_data(G_OBJECT(container), "basilisk-wpe-session"));
  if (!session) {
    nsresult rv = WPEGetProfileSession(chrome->IsPrivateBrowsing(), &session);
    NS_ENSURE_SUCCESS(rv, rv);
    g_object_set_data_full(G_OBJECT(container), "basilisk-wpe-session", session, g_object_unref);
  }
  mHost = wpe_host_new(session);
  NS_ENSURE_TRUE(mHost, NS_ERROR_FAILURE);
  mContainer = MOZ_CONTAINER(container);
  mListener = listener;
  g_signal_connect(session, "download-started", G_CALLBACK(+[](WebKitNetworkSession*,
    WebKitDownload* download, gpointer data) {
      auto* self = static_cast<WPEContentView*>(data);
      if (self->mHost && webkit_download_get_web_view(download) == self->mHost->webView)
        self->TrackDownload(download);
    }), this);
  webkit_settings_set_enable_developer_extras(webkit_web_view_get_settings(mHost->webView), !mPrivate);
  mHost->inspectorCreated = [](WPEView* view, void* data) {
    RefPtr<WPEContentView> self = static_cast<WPEContentView*>(data);
    RefPtr<WPEContentView> inspector = new WPEContentView();
    inspector->mInspectorView = WPE_VIEW(g_object_ref(view));
    for (size_t i = self->mInspectors.Length(); i; --i)
      if (self->mInspectors[i - 1]->mDestroyed) self->mInspectors.RemoveElementAt(i - 1);
    self->mInspectors.AppendElement(inspector);
    // Upstream finishes assigning the inspector toplevel before XUL mounts it.
    NS_DispatchToMainThread(NS_NewRunnableFunction([self, inspector]() {
      if (!self->mDestroyed) self->Notify("content-view-inspector", inspector);
      else inspector->Destroy();
    }));
  };
  mHost->chromeData = this;
  mHost->chromeCommand = [](const char* command, void* data) {
    RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("command"), nsDependentCString(command));
    static_cast<WPEContentView*>(data)->Notify("content-view-command",
      static_cast<nsIWritablePropertyBag2*>(info));
  };
  mLastError.Truncate();
  g_signal_connect(mHost->webView, "leave-fullscreen", G_CALLBACK(+[](WebKitWebView*, gpointer data) -> gboolean {
    auto* self = static_cast<WPEContentView*>(data);
    if (self->mHost && self->mHost->chromeCommand)
      self->mHost->chromeCommand("fullscreen-exit", self);
    return FALSE; // Let WPE finish its own fullscreen state transition too.
  }), this);
  auto* finder = webkit_web_view_get_find_controller(mHost->webView);
  g_signal_connect(finder, "found-text", G_CALLBACK(+[](WebKitFindController*, guint, gpointer data) {
    static_cast<WPEContentView*>(data)->Notify("content-view-find-found");
  }), this);
  g_signal_connect(finder, "failed-to-find-text", G_CALLBACK(+[](WebKitFindController*, gpointer data) {
    static_cast<WPEContentView*>(data)->Notify("content-view-find-not-found");
  }), this);
  for (const char* signal : {"notify::is-loading", "notify::is-playing-audio", "notify::is-muted"})
    g_signal_connect(mHost->webView, signal, G_CALLBACK(+[](GObject*, GParamSpec*, gpointer data) {
      static_cast<WPEContentView*>(data)->Notify("content-view-state");
    }), this);
  g_signal_connect(mHost->webView, "load-failed",
    G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent, const char*, GError* error, gpointer data) -> gboolean {
      if (g_error_matches(error, WEBKIT_NETWORK_ERROR, WEBKIT_NETWORK_ERROR_CANCELLED))
        return FALSE;
      auto* self = static_cast<WPEContentView*>(data);
      self->mLastError.Assign(error->message);
      self->Notify("content-view-state");
      return FALSE;
    }), this);
  g_signal_connect(mHost->webView, "create",
    G_CALLBACK(+[](WebKitWebView*, WebKitNavigationAction* action, gpointer data) -> WebKitWebView* {
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      const char* uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("uri"), nsDependentCString(uri ? uri : ""));
      info->SetPropertyAsBool(NS_LITERAL_STRING("userGesture"), webkit_navigation_action_is_user_gesture(action));
      static_cast<WPEContentView*>(data)->Notify("content-view-new-window",
        static_cast<nsIWritablePropertyBag2*>(info));
      return nullptr; // Only XUL may create tabs/windows; no unmanaged WPE views.
    }), this);
  g_signal_connect(mHost->webView, "notify::uri", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer data) {
    static_cast<WPEContentView*>(data)->Notify("content-view-state");
  }), this);
  g_signal_connect(mHost->webView, "notify::title", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer data) {
    static_cast<WPEContentView*>(data)->Notify("content-view-state");
  }), this);
  g_signal_connect(mHost->webView, "load-changed", G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent event, gpointer data) {
    auto* self = static_cast<WPEContentView*>(data);
    if (event == WEBKIT_LOAD_STARTED) self->CancelScripts();
    self->Notify("content-view-state");
  }), this);
  g_signal_connect(webkit_web_view_get_back_forward_list(mHost->webView), "changed",
    G_CALLBACK(+[](WebKitBackForwardList*, WebKitBackForwardListItem*, GList*, gpointer data) {
      static_cast<WPEContentView*>(data)->Notify("content-view-state");
    }), this);
  g_signal_connect(mHost->webView, "decide-policy",
    G_CALLBACK(+[](WebKitWebView*, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer data) -> gboolean {
      if (type != WEBKIT_POLICY_DECISION_TYPE_RESPONSE) return FALSE;
      auto* response = WEBKIT_RESPONSE_POLICY_DECISION(decision);
      if (!webkit_response_policy_decision_is_main_frame_main_resource(response) ||
          !webkit_response_policy_decision_is_mime_type_supported(response)) return FALSE;
      auto* request = webkit_response_policy_decision_get_request(response);
      if (g_strcmp0(webkit_uri_request_get_http_method(request), "GET")) return FALSE;
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("uri"), nsDependentCString(webkit_uri_request_get_uri(request)));
      info->SetPropertyAsBool(NS_LITERAL_STRING("handled"), false);
      static_cast<WPEContentView*>(data)->Notify("content-view-route", static_cast<nsIWritablePropertyBag2*>(info));
      bool handled = false;
      info->GetPropertyAsBool(NS_LITERAL_STRING("handled"), &handled);
      if (handled) webkit_policy_decision_ignore(decision);
      return handled;
    }), this);
  g_signal_connect(mHost->webView, "web-process-terminated",
    G_CALLBACK(+[](WebKitWebView*, WebKitWebProcessTerminationReason, gpointer data) {
      auto* self = static_cast<WPEContentView*>(data);
      self->CancelScripts();
      g_clear_object(&self->mInspectAction);
      RefPtr<WPEContentView> owner = self;
      NS_DispatchToMainThread(NS_NewRunnableFunction([owner]() {
        if (owner->mDestroyed) return;
        for (auto& inspector : owner->mInspectors) inspector->Destroy();
        owner->mInspectors.Clear();
      }));
      self->mLastError.AssignLiteral("The web content process terminated. Reload to retry.");
      self->Notify("content-view-process-terminated");
    }), this);
  g_signal_connect(mHost->webView, "context-menu",
    G_CALLBACK(+[](WebKitWebView* view, WebKitContextMenu* menu,
                   WebKitHitTestResult* hit, gpointer data) -> gboolean {
      auto* owner = static_cast<WPEContentView*>(data);
      g_clear_object(&owner->mInspectAction);
      for (GList* item = webkit_context_menu_get_items(menu); item; item = item->next) {
        auto* entry = WEBKIT_CONTEXT_MENU_ITEM(item->data);
        if (webkit_context_menu_item_get_stock_action(entry) == WEBKIT_CONTEXT_MENU_ACTION_INSPECT_ELEMENT)
          owner->mInspectAction = G_ACTION(g_object_ref(webkit_context_menu_item_get_gaction(entry)));
      }
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsBool(NS_LITERAL_STRING("canInspect"), owner->mInspectAction && !owner->mPrivate);
      auto text = [&](const char16_t* key, const char* value) {
        info->SetPropertyAsAUTF8String(nsDependentString(key), nsDependentCString(value ? value : ""));
      };
      text(u"pageURL", webkit_web_view_get_uri(view));
      text(u"linkURL", webkit_hit_test_result_get_link_uri(hit));
      text(u"imageURL", webkit_hit_test_result_get_image_uri(hit));
      text(u"mediaURL", webkit_hit_test_result_get_media_uri(hit));
      // Hit testing reports selection state, not the selected text. Do not
      // pretend to supply text until an asynchronous content bridge exists.
      info->SetPropertyAsBool(NS_LITERAL_STRING("isLink"), webkit_hit_test_result_context_is_link(hit));
      info->SetPropertyAsBool(NS_LITERAL_STRING("isImage"), webkit_hit_test_result_context_is_image(hit));
      info->SetPropertyAsBool(NS_LITERAL_STRING("isMedia"), webkit_hit_test_result_context_is_media(hit));
      info->SetPropertyAsBool(NS_LITERAL_STRING("isEditable"), webkit_hit_test_result_context_is_editable(hit));
      info->SetPropertyAsBool(NS_LITERAL_STRING("hasSelection"), webkit_hit_test_result_context_is_selection(hit));
      int x = 0;
      int y = 0;
      webkit_context_menu_get_position(menu, &x, &y);
      auto* self = static_cast<WPEContentView*>(data);
      int scale = self->mHost ? WPEGtk::Get().scaleFactor(self->mHost->area) : 1;
      info->SetPropertyAsInt32(NS_LITERAL_STRING("x"), x * scale);
      info->SetPropertyAsInt32(NS_LITERAL_STRING("y"), y * scale);
      static_cast<WPEContentView*>(data)->Notify("content-view-context-menu",
        static_cast<nsIWritablePropertyBag2*>(info));
      return TRUE; // XUL owns the menu; suppress backend UI.
    }), this);
  return Mount(native);
}
nsresult WPEContentView::Mount(GdkWindow* native)
{
  gtk_widget_set_parent_window(mHost->area, native);
  moz_container_put(mContainer, mHost->area, 0, 0);
  // Give the foreign surface its own native child window. A client-side GDK
  // window alone is not a clipping boundary for Gecko's compositor output.
  gtk_widget_realize(mHost->area);
  if (!WPEGtk::Get().ensureNative(gtk_widget_get_window(mHost->area))) {
    Destroy();
    return NS_ERROR_NOT_AVAILABLE;
  }
  // Native parent destruction can precede the XUL unload handler.
  g_signal_connect(mHost->area, "destroy", G_CALLBACK(+[](GtkWidget*, gpointer data) {
    static_cast<WPEContentView*>(data)->Destroy();
  }), this);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::SetBounds(int32_t x, int32_t y, int32_t width, int32_t height)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  NS_ENSURE_TRUE(width > 0 && height > 0 && width <= 16384 && height <= 16384,
                 NS_ERROR_INVALID_ARG);
  mBounds[0] = x;
  mBounds[1] = y;
  mBounds[2] = width;
  mBounds[3] = height;
  int scale = WPEGtk::Get().scaleFactor(mHost->area);
  int nativeWidth = (width + scale - 1) / scale;
  int nativeHeight = (height + scale - 1) / scale;
  moz_container_move(mContainer, mHost->area, x / scale, y / scale, nativeWidth, nativeHeight);
  wpe_toplevel_scale_changed(mHost->toplevel, scale);
  wpe_host_resize(mHost, nativeWidth, nativeHeight);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::SetVisible(bool visible)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  if (visible) {
    gtk_widget_show(mHost->area);
    // GTK ignores size allocation for hidden widgets. Reapply the owner's
    // requested rectangle after mapping instead of leaving a 1x1 child.
    return SetBounds(mBounds[0], mBounds[1], mBounds[2], mBounds[3]);
  }
  gtk_widget_hide(mHost->area);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::Focus()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  gtk_widget_grab_focus(mHost->area);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::Destroy()
{
  if (mDestroyed) return NS_OK;
  mDestroyed = true;
  CancelScripts();
  if (mStyleSheets) { g_hash_table_unref(mStyleSheets); mStyleSheets = nullptr; }
  if (mUserScripts) { g_hash_table_unref(mUserScripts); mUserScripts = nullptr; }
  for (auto& inspector : mInspectors) inspector->Destroy();
  mInspectors.Clear();
  if (mInspectorView) Notify("content-view-closed");
  mListener = nullptr;
  g_clear_object(&mInspectAction);
  if (mInspectorView) wpe_view_closed(mInspectorView);
  for (auto* download : mDownloads) {
    g_signal_handlers_disconnect_by_data(download, this);
    webkit_download_cancel(download);
    g_object_unref(download);
  }
  mDownloads.Clear();
  if (mHost) {
    WPEHost* host = mHost;
    mHost = nullptr;
    mContainer = nullptr;
    g_signal_handlers_disconnect_by_data(host->area, this);
    if (host->webView) {
      g_signal_handlers_disconnect_by_data(host->webView, this);
      g_signal_handlers_disconnect_by_data(webkit_web_view_get_user_content_manager(host->webView), this);
      g_signal_handlers_disconnect_by_data(webkit_web_view_get_network_session(host->webView), this);
      g_signal_handlers_disconnect_by_data(webkit_web_view_get_find_controller(host->webView), this);
      g_signal_handlers_disconnect_by_data(webkit_web_view_get_back_forward_list(host->webView), this);
    }
    wpe_host_free(host);
  }
  g_clear_object(&mInspectorView);
  return NS_OK;
}
void WPEContentView::TrackDownload(WebKitDownload* download)
{
  mDownloads.AppendElement(static_cast<WebKitDownload*>(g_object_ref(download)));
  g_signal_connect(download, "decide-destination", G_CALLBACK(+[](WebKitDownload* download,
    const char* filename, gpointer data) -> gboolean {
      RefPtr<WPEContentView> self = static_cast<WPEContentView*>(data);
      g_object_ref(download); // A modal XUL picker may destroy the owning tab.
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("filename"), nsDependentCString(filename));
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("path"), EmptyCString());
      self->Notify("content-view-download-request", static_cast<nsIWritablePropertyBag2*>(info));
      nsAutoCString path;
      info->GetPropertyAsAUTF8String(NS_LITERAL_STRING("path"), path);
      if (!self->mHost || path.IsEmpty()) webkit_download_cancel(download);
      else {
        // The XUL save picker has already confirmed replacement, if needed.
        webkit_download_set_allow_overwrite(download, TRUE);
        webkit_download_set_destination(download, path.get());
      }
      g_object_unref(download);
      return TRUE;
    }), this);
  g_signal_connect(download, "failed", G_CALLBACK(+[](WebKitDownload* download,
    GError* error, gpointer) {
      g_object_set_data_full(G_OBJECT(download), "basilisk-error", g_strdup(error->message), g_free);
    }), this);
  g_signal_connect(download, "finished", G_CALLBACK(+[](WebKitDownload* download, gpointer data) {
    RefPtr<WPEContentView> self = static_cast<WPEContentView*>(data);
    self->mDownloads.RemoveElement(download);
    g_signal_handlers_disconnect_by_data(download, self.get());
    RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
    const char* path = webkit_download_get_destination(download);
    const char* error = static_cast<const char*>(g_object_get_data(G_OBJECT(download), "basilisk-error"));
    const char* uri = webkit_uri_request_get_uri(webkit_download_get_request(download));
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("uri"), nsDependentCString(uri ? uri : ""));
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("path"), nsDependentCString(path ? path : ""));
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(error ? error : ""));
    self->Notify("content-view-download-finished", static_cast<nsIWritablePropertyBag2*>(info));
    g_object_unref(download);
  }), this);
}
NS_IMETHODIMP WPEContentView::Blur()
{
  NS_ENSURE_TRUE(mHost && mContainer, NS_ERROR_NOT_INITIALIZED);
  gtk_widget_grab_focus(GTK_WIDGET(mContainer));
  return NS_OK;
}
void WPEContentView::Notify(const char* topic, nsISupports* subject)
{
  // Listener code can synchronously close the host. Keep the component and
  // emitter alive until the callback returns, and never access mHost afterward.
  RefPtr<WPEContentView> self(this);
  nsCOMPtr<nsIContentViewObserver> listener = mListener;
  auto* view = mHost ? mHost->webView : nullptr;
  if (view) g_object_ref(view);
  if (listener) listener->OnContentEvent(this, nsDependentCString(topic), subject ? subject : this);
  if (view) g_object_unref(view);
}

NS_IMETHODIMP WPEContentView::LoadURI(const nsACString& value)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  nsCOMPtr<nsIURI> uri;
  nsresult rv = NS_NewURI(getter_AddRefs(uri), value);
  NS_ENSURE_SUCCESS(rv, rv);
  bool http = false, https = false;
  uri->SchemeIs("http", &http);
  uri->SchemeIs("https", &https);
  NS_ENSURE_TRUE(http || https || value.EqualsLiteral("about:blank"), NS_ERROR_DOM_BAD_URI);
  nsAutoCString spec;
  uri->GetSpec(spec);
  mLastError.Truncate();
  webkit_web_view_load_uri(mHost->webView, spec.get());
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::Reload()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  mLastError.Truncate();
  webkit_web_view_reload(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::Stop()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_stop_loading(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GoBack()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_go_back(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GoForward()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_go_forward(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GetCanGoBack(bool* value)
{ *value = mHost && webkit_web_view_can_go_back(mHost->webView); return NS_OK; }
NS_IMETHODIMP WPEContentView::GetCanGoForward(bool* value)
{ *value = mHost && webkit_web_view_can_go_forward(mHost->webView); return NS_OK; }
NS_IMETHODIMP WPEContentView::GetCurrentURI(nsACString& value)
{
  const char* uri = mHost ? webkit_web_view_get_uri(mHost->webView) : nullptr;
  value.Assign(uri ? uri : "");
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GetTitle(nsACString& value)
{
  const char* title = mHost ? webkit_web_view_get_title(mHost->webView) : nullptr;
  value.Assign(title ? title : "");
  return NS_OK;
}

NS_IMETHODIMP WPEContentView::GetEngineId(nsACString& value)
{ value.AssignLiteral("webkit"); return NS_OK; }
NS_IMETHODIMP WPEContentView::GetLoading(bool* value)
{ *value = mHost && webkit_web_view_is_loading(mHost->webView); return NS_OK; }
NS_IMETHODIMP WPEContentView::GetFocused(bool* value)
{ *value = mHost && gtk_widget_has_focus(mHost->area); return NS_OK; }
NS_IMETHODIMP WPEContentView::GetLastError(nsACString& value)
{ value = mLastError; return NS_OK; }
NS_IMETHODIMP WPEContentView::GetZoom(double* value)
{ *value = mHost ? webkit_web_view_get_zoom_level(mHost->webView) : 1; return NS_OK; }
NS_IMETHODIMP WPEContentView::SetZoom(double value)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  NS_ENSURE_TRUE(value >= 0.1 && value <= 10, NS_ERROR_INVALID_ARG);
  webkit_web_view_set_zoom_level(mHost->webView, value);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GetMuted(bool* value)
{ *value = mHost && webkit_web_view_get_is_muted(mHost->webView); return NS_OK; }
NS_IMETHODIMP WPEContentView::SetMuted(bool value)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_set_is_muted(mHost->webView, value);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::GetAudioPlaying(bool* value)
{ *value = mHost && webkit_web_view_is_playing_audio(mHost->webView); return NS_OK; }
NS_IMETHODIMP WPEContentView::Edit(const nsACString& command)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  const char* native = command.EqualsLiteral("copy") ? "Copy" :
    command.EqualsLiteral("cut") ? "Cut" : command.EqualsLiteral("paste") ? "Paste" :
    command.EqualsLiteral("selectAll") ? "SelectAll" : nullptr;
  NS_ENSURE_TRUE(native, NS_ERROR_INVALID_ARG);
  webkit_web_view_execute_editing_command(mHost->webView, native);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::Find(const nsACString& text, bool backwards, bool caseSensitive)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  guint options = WEBKIT_FIND_OPTIONS_WRAP_AROUND;
  if (backwards) options |= WEBKIT_FIND_OPTIONS_BACKWARDS;
  if (!caseSensitive) options |= WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE;
  webkit_find_controller_search(webkit_web_view_get_find_controller(mHost->webView),
    PromiseFlatCString(text).get(), options, G_MAXUINT);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::ClearFind()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_find_controller_search_finish(webkit_web_view_get_find_controller(mHost->webView));
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::FindAgain(bool backwards)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  auto* finder = webkit_web_view_get_find_controller(mHost->webView);
  if (backwards) webkit_find_controller_search_previous(finder);
  else webkit_find_controller_search_next(finder);
  return NS_OK;
}

#define WEBKIT_CONTENT_VIEW_CID \
  {0x6eed5bf2, 0xe641, 0x43fb, {0x86, 0xb3, 0x79, 0x87, 0xc8, 0xea, 0x58, 0xe2}}
NS_GENERIC_FACTORY_CONSTRUCTOR(WPEContentView)
NS_DEFINE_NAMED_CID(WEBKIT_CONTENT_VIEW_CID);
static const mozilla::Module::CIDEntry kCIDs[] = {
  { &kWEBKIT_CONTENT_VIEW_CID, false, nullptr, WPEContentViewConstructor,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
static const mozilla::Module::ContractIDEntry kContracts[] = {
  { "@basilisk-browser.org/content-view;1?engine=webkit", &kWEBKIT_CONTENT_VIEW_CID,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
static const mozilla::Module kModule = {
  mozilla::Module::kVersion, kCIDs, kContracts
};
NSMODULE_DEFN(WPEContentViewModule) = &kModule;

NS_IMETHODIMP WPEContentView::OpenDeveloperTools()
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mPrivate, NS_ERROR_NOT_AVAILABLE);
  for (auto& inspector : mInspectors) {
    if (!inspector->mDestroyed) {
      inspector->Destroy();
      return NS_OK;
    }
  }
  webkit_web_view_toggle_inspector(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::InspectElement()
{
  NS_ENSURE_TRUE(mHost && mInspectAction && !mPrivate, NS_ERROR_NOT_AVAILABLE);
  // Retain WebKit's action and actual context target, never re-hit-test in XUL.
  GAction* action = G_ACTION(g_object_ref(mInspectAction));
  g_action_activate(action, nullptr);
  g_object_unref(action);
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::SetFullscreen(bool active)
{
  NS_ENSURE_TRUE(mHost && mHost->toplevel, NS_ERROR_NOT_INITIALIZED);
  auto state = wpe_toplevel_get_state(mHost->toplevel);
  wpe_toplevel_state_changed(mHost->toplevel, static_cast<WPEToplevelState>(
    active ? state | WPE_TOPLEVEL_STATE_FULLSCREEN : state & ~WPE_TOPLEVEL_STATE_FULLSCREEN));
  return NS_OK;
}
