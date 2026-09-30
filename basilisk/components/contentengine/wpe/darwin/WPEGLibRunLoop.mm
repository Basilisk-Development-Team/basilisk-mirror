/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEGLibRunLoop.h"
#include <cassert>
#include <pthread.h>

std::shared_ptr<WPEGLibRunLoop> WPEGLibRunLoop::Create(GMainContext* context)
{
  assert(pthread_main_np());
  auto bridge = std::shared_ptr<WPEGLibRunLoop>(new WPEGLibRunLoop(context));
  bridge->Start();
  return bridge;
}

WPEGLibRunLoop::WPEGLibRunLoop(GMainContext* context)
  : mContext(g_main_context_ref(context))
{
}

void WPEGLibRunLoop::Start()
{
  // Match g_main_loop_run's ownership across waits. Without this, GLib may
  // execute g_main_context_invoke(defaultContext, ...) on a worker that happens
  // to acquire an otherwise idle default context.
  if (!g_main_context_acquire(mContext)) g_error("WPE UI context has another owner");
  CFRunLoopSourceContext source = {};
  source.info = this;
  source.perform = [](void* data) {
    auto bridge = static_cast<WPEGLibRunLoop*>(data)->shared_from_this();
    bridge->Dispatch();
  };
  mDispatchSource = CFRunLoopSourceCreate(nullptr, 0, &source);
  CFRunLoopAddSource(CFRunLoopGetMain(), mDispatchSource, kCFRunLoopCommonModes);

  CFRunLoopObserverContext observer = {0, this, nullptr, nullptr, nullptr};
  mObserver = CFRunLoopObserverCreate(nullptr, kCFRunLoopBeforeWaiting, true, 0,
    [](CFRunLoopObserverRef, CFRunLoopActivity, void* data) {
      auto bridge = static_cast<WPEGLibRunLoop*>(data)->shared_from_this();
      bridge->Refresh();
    }, &observer);
  CFRunLoopAddObserver(CFRunLoopGetMain(), mObserver, kCFRunLoopCommonModes);
  Schedule();
}

void WPEGLibRunLoop::Schedule()
{
  assert(pthread_main_np());
  if (mStopped) return;
  CFRunLoopSourceSignal(mDispatchSource);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

void WPEGLibRunLoop::Dispatch()
{
  assert(pthread_main_np());
  if (mStopped || mDispatching) return;
  mDispatching = true;
  // Do not monopolize AppKit when a GLib source continually remains ready.
  // The next turn is explicitly signalled, never delayed by a polling timer.
  unsigned iterations = 0;
  while (!mStopped && iterations < 64 && g_main_context_iteration(mContext, false))
    ++iterations;
  mDispatching = false;
  if (mStopped) return;
  // A dispatch can close/reuse an fd, even with the same numeric poll set.
  // Rebuild after actual GLib work; never rebuild merely because AppKit is
  // about to sleep (adding CF sources itself wakes the native runloop).
  ClearWatches();
  Refresh();
  if (iterations == 64) Schedule();
}

void WPEGLibRunLoop::ClearWatches()
{
  if (mTimer) {
    CFRunLoopTimerInvalidate(mTimer);
    CFRelease(mTimer);
    mTimer = nullptr;
  }
  for (auto descriptor : mDescriptors) {
    CFFileDescriptorInvalidate(descriptor);
    CFRelease(descriptor);
  }
  mDescriptors.clear();
  mPollFDs.clear();
}

void WPEGLibRunLoop::Refresh()
{
  assert(pthread_main_np());
  if (mStopped || mDispatching) return;
  // The embedding UI thread owns this context's iteration. Other threads may
  // attach sources/wake it, but must not run its callbacks concurrently.
  if (!g_main_context_acquire(mContext)) g_error("WPE UI context has another owner");
  int priority = 0, timeout = -1;
  bool ready = g_main_context_prepare(mContext, &priority);
  std::vector<GPollFD> fds;
  int count;
  while ((count = g_main_context_query(mContext, priority, &timeout, fds.data(), fds.size())) > int(fds.size()))
    fds.resize(count);
  fds.resize(count);
  g_main_context_release(mContext);

  bool changed = fds.size() != mPollFDs.size();
  for (size_t i = 0; !changed && i < fds.size(); ++i)
    changed = fds[i].fd != mPollFDs[i].fd || fds[i].events != mPollFDs[i].events;
  if (changed) ClearWatches();
  CFFileDescriptorContext descriptorContext = {0, this, nullptr, nullptr, nullptr};
  if (changed) for (const auto& fd : fds) {
    if (fd.fd < 0) continue;
    CFOptionFlags flags = 0;
    if (fd.events & (G_IO_IN | G_IO_PRI)) flags |= kCFFileDescriptorReadCallBack;
    if (fd.events & G_IO_OUT) flags |= kCFFileDescriptorWriteCallBack;
    if (!flags) continue;
    auto descriptor = CFFileDescriptorCreate(nullptr, fd.fd, false,
      [](CFFileDescriptorRef, CFOptionFlags, void* data) {
        auto bridge = static_cast<WPEGLibRunLoop*>(data)->shared_from_this();
        bridge->Schedule();
      }, &descriptorContext);
    if (!descriptor) g_error("Unable to watch WPE UI descriptor");
    auto source = CFFileDescriptorCreateRunLoopSource(nullptr, descriptor, 0);
    if (!source) g_error("Unable to create WPE UI descriptor source");
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CFRelease(source);
    CFFileDescriptorEnableCallBacks(descriptor, flags);
    mDescriptors.push_back(descriptor);
  }
  mPollFDs = std::move(fds);
  if (ready || !timeout) {
    Schedule();
  } else if (timeout > 0) {
    auto fire = CFAbsoluteTimeGetCurrent() + timeout / 1000.0;
    if (mTimer) {
      // Keep an existing earlier deadline. Moving it forward on every native
      // turn could indefinitely postpone a GLib timer under continuous input.
      if (fire < CFRunLoopTimerGetNextFireDate(mTimer))
        CFRunLoopTimerSetNextFireDate(mTimer, fire);
      return;
    }
    CFRunLoopTimerContext timer = {0, this, nullptr, nullptr, nullptr};
    mTimer = CFRunLoopTimerCreate(nullptr, fire,
      0, 0, 0, [](CFRunLoopTimerRef, void* data) {
        auto bridge = static_cast<WPEGLibRunLoop*>(data)->shared_from_this();
        bridge->Schedule();
      }, &timer);
    CFRunLoopAddTimer(CFRunLoopGetMain(), mTimer, kCFRunLoopCommonModes);
  }
}

void WPEGLibRunLoop::Stop()
{
  assert(pthread_main_np());
  if (mStopped) return;
  mStopped = true;
  ClearWatches();
  if (mObserver) {
    CFRunLoopObserverInvalidate(mObserver);
    CFRelease(mObserver);
    mObserver = nullptr;
  }
  if (mDispatchSource) {
    CFRunLoopSourceInvalidate(mDispatchSource);
    CFRelease(mDispatchSource);
    mDispatchSource = nullptr;
  }
  g_main_context_release(mContext);
}

WPEGLibRunLoop::~WPEGLibRunLoop()
{
  Stop();
  g_main_context_unref(mContext);
}
