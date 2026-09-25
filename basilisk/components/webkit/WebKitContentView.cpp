/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WebKitContentView.h"
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
#include "WPEGtk.h"

NS_IMPL_ISUPPORTS(WebKitContentView, nsIWebContentView)
WebKitContentView::~WebKitContentView() { Destroy(); }
NS_IMETHODIMP WebKitContentView::Attach(mozIDOMWindowProxy* window, nsIObserver* listener)
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  NS_ENSURE_ARG_POINTER(window);
  NS_ENSURE_ARG_POINTER(listener);
  NS_ENSURE_TRUE(!mHost, NS_ERROR_ALREADY_INITIALIZED);
  auto* chrome = nsGlobalWindow::Cast(window);
  NS_ENSURE_TRUE(chrome->IsChromeWindow(), NS_ERROR_DOM_SECURITY_ERR);
  nsCOMPtr<nsIWidget> widget = chrome->GetMainWidget();
  NS_ENSURE_TRUE(widget, NS_ERROR_NOT_AVAILABLE);
  auto* native = static_cast<GdkWindow*>(widget->GetNativeData(NS_NATIVE_WIDGET));
  NS_ENSURE_TRUE(native, NS_ERROR_NOT_AVAILABLE);
  gpointer container = nullptr;
  gdk_window_get_user_data(native, &container);
  NS_ENSURE_TRUE(container && IS_MOZ_CONTAINER(container), NS_ERROR_NOT_AVAILABLE);
  mHost = wpe_host_new();
  NS_ENSURE_TRUE(mHost, NS_ERROR_FAILURE);
  mContainer = MOZ_CONTAINER(container);
  mListener = listener;
  g_signal_connect(mHost->webView, "notify::uri", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer data) {
    static_cast<WebKitContentView*>(data)->Notify("content-view-state");
  }), this);
  g_signal_connect(mHost->webView, "notify::title", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer data) {
    static_cast<WebKitContentView*>(data)->Notify("content-view-state");
  }), this);
  g_signal_connect(mHost->webView, "load-changed", G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent, gpointer data) {
    static_cast<WebKitContentView*>(data)->Notify("content-view-state");
  }), this);
  g_signal_connect(webkit_web_view_get_back_forward_list(mHost->webView), "changed",
    G_CALLBACK(+[](WebKitBackForwardList*, WebKitBackForwardListItem*, GList*, gpointer data) {
      static_cast<WebKitContentView*>(data)->Notify("content-view-state");
    }), this);
  g_signal_connect(mHost->webView, "web-process-terminated",
    G_CALLBACK(+[](WebKitWebView*, WebKitWebProcessTerminationReason, gpointer data) {
      static_cast<WebKitContentView*>(data)->Notify("content-view-process-terminated");
    }), this);
  g_signal_connect(mHost->webView, "context-menu",
    G_CALLBACK(+[](WebKitWebView* view, WebKitContextMenu* menu,
                   WebKitHitTestResult* hit, gpointer data) -> gboolean {
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
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
      auto* self = static_cast<WebKitContentView*>(data);
      int scale = self->mHost ? WPEGtk::Get().scaleFactor(self->mHost->area) : 1;
      info->SetPropertyAsInt32(NS_LITERAL_STRING("x"), x * scale);
      info->SetPropertyAsInt32(NS_LITERAL_STRING("y"), y * scale);
      static_cast<WebKitContentView*>(data)->Notify("content-view-context-menu",
        static_cast<nsIWritablePropertyBag2*>(info));
      return TRUE; // XUL owns the menu; suppress backend UI.
    }), this);
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
    static_cast<WebKitContentView*>(data)->Destroy();
  }), this);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::SetBounds(int32_t x, int32_t y, int32_t width, int32_t height)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  NS_ENSURE_TRUE(width > 0 && height > 0 && width <= 16384 && height <= 16384,
                 NS_ERROR_INVALID_ARG);
  int scale = WPEGtk::Get().scaleFactor(mHost->area);
  int nativeWidth = (width + scale - 1) / scale;
  int nativeHeight = (height + scale - 1) / scale;
  moz_container_move(mContainer, mHost->area, x / scale, y / scale, nativeWidth, nativeHeight);
  wpe_toplevel_scale_changed(mHost->toplevel, scale);
  wpe_host_resize(mHost, nativeWidth, nativeHeight);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::SetVisible(bool visible)
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  if (visible) gtk_widget_show(mHost->area);
  else gtk_widget_hide(mHost->area);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::Focus()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  gtk_widget_grab_focus(mHost->area);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::Destroy()
{
  mListener = nullptr;
  if (mHost) {
    WPEHost* host = mHost;
    mHost = nullptr;
    mContainer = nullptr;
    g_signal_handlers_disconnect_by_data(host->area, this);
    g_signal_handlers_disconnect_by_data(host->webView, this);
    g_signal_handlers_disconnect_by_data(webkit_web_view_get_back_forward_list(host->webView), this);
    wpe_host_free(host);
  }
  return NS_OK;
}
void WebKitContentView::Notify(const char* topic, nsISupports* subject)
{
  // Listener code can synchronously close the host. Keep the component and
  // emitter alive until the callback returns, and never access mHost afterward.
  RefPtr<WebKitContentView> self(this);
  nsCOMPtr<nsIObserver> listener = mListener;
  auto* view = mHost ? mHost->webView : nullptr;
  if (view) g_object_ref(view);
  if (listener) listener->Observe(subject ? subject : this, topic, nullptr);
  if (view) g_object_unref(view);
}

NS_IMETHODIMP WebKitContentView::LoadURI(const nsACString& value)
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
  webkit_web_view_load_uri(mHost->webView, spec.get());
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::Reload()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_reload(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::Stop()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_stop_loading(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::GoBack()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_go_back(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::GoForward()
{
  NS_ENSURE_TRUE(mHost, NS_ERROR_NOT_INITIALIZED);
  webkit_web_view_go_forward(mHost->webView);
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::GetCanGoBack(bool* value)
{ *value = mHost && webkit_web_view_can_go_back(mHost->webView); return NS_OK; }
NS_IMETHODIMP WebKitContentView::GetCanGoForward(bool* value)
{ *value = mHost && webkit_web_view_can_go_forward(mHost->webView); return NS_OK; }
NS_IMETHODIMP WebKitContentView::GetCurrentURI(nsACString& value)
{
  const char* uri = mHost ? webkit_web_view_get_uri(mHost->webView) : nullptr;
  value.Assign(uri ? uri : "");
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::GetTitle(nsACString& value)
{
  const char* title = mHost ? webkit_web_view_get_title(mHost->webView) : nullptr;
  value.Assign(title ? title : "");
  return NS_OK;
}

#define WEBKIT_CONTENT_VIEW_CID \
  {0x6eed5bf2, 0xe641, 0x43fb, {0x86, 0xb3, 0x79, 0x87, 0xc8, 0xea, 0x58, 0xe2}}
NS_GENERIC_FACTORY_CONSTRUCTOR(WebKitContentView)
NS_DEFINE_NAMED_CID(WEBKIT_CONTENT_VIEW_CID);
static const mozilla::Module::CIDEntry kCIDs[] = {
  { &kWEBKIT_CONTENT_VIEW_CID, false, nullptr, WebKitContentViewConstructor,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
static const mozilla::Module::ContractIDEntry kContracts[] = {
  { "@basilisk-browser.org/web-content-view/wpe;1", &kWEBKIT_CONTENT_VIEW_CID,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
static const mozilla::Module kModule = {
  mozilla::Module::kVersion, kCIDs, kContracts
};
NSMODULE_DEFN(WebKitContentViewModule) = &kModule;
