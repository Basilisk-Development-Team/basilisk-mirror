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
#include "mozcontainer.h"
#include "WPEHost.h"

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
  gtk_widget_set_parent_window(mHost->area, native);
  moz_container_put(mContainer, mHost->area, 0, 0);
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
  moz_container_move(mContainer, mHost->area, x, y, width, height);
  wpe_host_resize(mHost, width, height);
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
void WebKitContentView::Notify(const char* topic, const char16_t* data)
{
  // Listener code can synchronously close the host. Keep the component and
  // emitter alive until the callback returns, and never access mHost afterward.
  RefPtr<WebKitContentView> self(this);
  nsCOMPtr<nsIObserver> listener = mListener;
  auto* view = mHost ? mHost->webView : nullptr;
  if (view) g_object_ref(view);
  if (listener) listener->Observe(this, topic, data);
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
  { &kWEBKIT_CONTENT_VIEW_CID, false, nullptr, WebKitContentViewConstructor },
  { nullptr }
};
static const mozilla::Module::ContractIDEntry kContracts[] = {
  { "@basilisk-browser.org/web-content-view/wpe;1", &kWEBKIT_CONTENT_VIEW_CID },
  { nullptr }
};
static const mozilla::Module kModule = {
  mozilla::Module::kVersion, kCIDs, kContracts
};
NSMODULE_DEFN(WebKitContentViewModule) = &kModule;
