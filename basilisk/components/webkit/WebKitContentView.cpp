/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WebKitContentView.h"
#include "mozilla/ModuleUtils.h"
#include "nsString.h"
#include "nsGlobalWindow.h"
#include "nsIWidget.h"
#include "nsThreadUtils.h"
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
    wpe_host_free(host);
  }
  return NS_OK;
}
NS_IMETHODIMP WebKitContentView::LoadURI(const nsACString&)
{ return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::Reload() { return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::Stop() { return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::GoBack() { return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::GoForward() { return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::GetCanGoBack(bool* value)
{ *value = false; return NS_OK; }
NS_IMETHODIMP WebKitContentView::GetCanGoForward(bool* value)
{ *value = false; return NS_OK; }
NS_IMETHODIMP WebKitContentView::GetCurrentURI(nsACString& value)
{ value.Truncate(); return NS_OK; }
NS_IMETHODIMP WebKitContentView::GetTitle(nsACString& value)
{ value.Truncate(); return NS_OK; }

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
