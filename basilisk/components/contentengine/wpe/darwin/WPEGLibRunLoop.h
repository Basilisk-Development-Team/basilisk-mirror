/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEGLibRunLoop_h
#define WPEGLibRunLoop_h

#include <CoreFoundation/CoreFoundation.h>
#include <glib.h>
#include <memory>
#include <vector>

// Backend-private GLib/AppKit integration. Create, dispatch and release on the
// main thread. Callbacks hold a temporary owner so a callback may release the
// last embedding view without deleting the bridge underneath GLib dispatch.
class WPEGLibRunLoop final : public std::enable_shared_from_this<WPEGLibRunLoop> {
public:
  static std::shared_ptr<WPEGLibRunLoop> Create(GMainContext*);
  ~WPEGLibRunLoop();
  void Stop();
private:
  explicit WPEGLibRunLoop(GMainContext*);
  void Start();
  void Schedule();
  void Dispatch();
  void Refresh();
  void ClearWatches();
  GMainContext* mContext;
  CFRunLoopSourceRef mDispatchSource = nullptr;
  CFRunLoopObserverRef mObserver = nullptr;
  CFRunLoopTimerRef mTimer = nullptr;
  std::vector<CFFileDescriptorRef> mDescriptors;
  std::vector<GPollFD> mPollFDs;
  bool mStopped = false;
  bool mDispatching = false;
};
#endif
