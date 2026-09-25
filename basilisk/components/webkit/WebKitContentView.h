/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WebKitContentView_h
#define WebKitContentView_h

#include "nsIWebContentView.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"

struct WPEHost;
struct _MozContainer;

class WebKitContentView final : public nsIWebContentView
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWEBCONTENTVIEW
  WebKitContentView() = default;
  void Notify(const char* topic, nsISupports* subject = nullptr);
private:
  ~WebKitContentView();
  WPEHost* mHost = nullptr;
  _MozContainer* mContainer = nullptr;
  nsCOMPtr<nsIObserver> mListener;
  int32_t mBounds[4] = {0, 0, 1, 1};
};
#endif
