/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEContentView_h
#define WPEContentView_h

#include "nsIWebContentView.h"
#include "nsCOMPtr.h"
#include "nsIContentViewObserver.h"
#include "nsString.h"
#include "nsTArray.h"

struct WPEHost;
struct _MozContainer;
struct _WebKitDownload;
struct _WPEView;
struct _GAction;
struct _GdkWindow;
struct _GCancellable;
struct _GHashTable;

class WPEContentView final : public nsIWebContentView
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWEBCONTENTVIEW
  WPEContentView() = default;
  void Notify(const char* topic, nsISupports* subject = nullptr);
  void TrackDownload(_WebKitDownload* download);
private:
  ~WPEContentView();
  nsresult Mount(_GdkWindow* native);
  void CancelScripts();
  void EnsureMessaging();
  WPEHost* mHost = nullptr;
  _MozContainer* mContainer = nullptr;
  nsCOMPtr<nsIContentViewObserver> mListener;
  int32_t mBounds[4] = {0, 0, 1, 1};
  nsCString mLastError;
  nsTArray<_WebKitDownload*> mDownloads;
  nsTArray<RefPtr<WPEContentView>> mInspectors;
  _WPEView* mInspectorView = nullptr;
  _GAction* mInspectAction = nullptr;
  bool mDestroyed = false;
  bool mPrivate = false;
  _GCancellable* mScriptCancellation = nullptr;
  bool mMessaging = false;
  _GHashTable* mStyleSheets = nullptr;
  _GHashTable* mUserScripts = nullptr;
};
#endif
