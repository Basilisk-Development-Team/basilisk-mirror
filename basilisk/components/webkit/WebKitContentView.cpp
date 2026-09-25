/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WebKitContentView.h"
#include "mozilla/ModuleUtils.h"
#include "nsString.h"

NS_IMPL_ISUPPORTS(WebKitContentView, nsIWebContentView)
WebKitContentView::~WebKitContentView() { Destroy(); }
NS_IMETHODIMP WebKitContentView::Attach(mozIDOMWindowProxy*, nsIObserver*)
{ return NS_ERROR_NOT_IMPLEMENTED; }
NS_IMETHODIMP WebKitContentView::SetBounds(int32_t, int32_t, int32_t, int32_t)
{ return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::SetVisible(bool)
{ return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::Focus() { return NS_ERROR_NOT_INITIALIZED; }
NS_IMETHODIMP WebKitContentView::Destroy() { return NS_OK; }
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
