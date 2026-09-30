/* Standalone Darwin/GLib lifetime test; not shipped in the application. */
#include "WPEGLibRunLoop.h"
#include <glib-unix.h>
#include <pthread.h>
#include <thread>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>

static void Check(bool value, const char* message)
{
  if (!value) { fprintf(stderr, "FAIL %s\n", message); abort(); }
}

struct State {
  unsigned events = 0;
  void Event(unsigned mask) {
    Check(pthread_main_np(), "callback must execute on main thread");
    Check(!(events & mask), "duplicate callback");
    events |= mask;
    if (events == 7) CFRunLoopStop(CFRunLoopGetMain());
  }
};

int main(int argc, char** argv)
{
  unsigned rounds = argc > 1 ? unsigned(strtoul(argv[1], nullptr, 10)) : 1;
  Check(rounds > 0 && rounds <= 10000, "bounded round count");
  for (unsigned round = 0; round < rounds; ++round) {
  // Use the actual default context, including GLib's invoke-on-owner shortcut.
  auto* context = g_main_context_default();
  auto bridge = WPEGLibRunLoop::Create(context);
  State state;
  auto* timer = g_timeout_source_new(10);
  g_source_set_callback(timer, [](void* data) -> gboolean {
    static_cast<State*>(data)->Event(1); return G_SOURCE_REMOVE;
  }, &state, nullptr);
  g_source_attach(timer, context);
  int descriptors[2]; Check(!pipe(descriptors), "create pipe");
  auto* input = g_unix_fd_source_new(descriptors[0], G_IO_IN);
  g_source_set_callback(input, G_SOURCE_FUNC(+[](int fd, GIOCondition, void* data) -> gboolean {
    char value; Check(read(fd, &value, 1) == 1 && value == 'x', "pipe callback");
    static_cast<State*>(data)->Event(2); return G_SOURCE_REMOVE;
  }), &state, nullptr);
  g_source_attach(input, context);
  std::thread worker([&] {
    g_main_context_invoke(context, [](void* data) -> gboolean {
      static_cast<State*>(data)->Event(4); return G_SOURCE_REMOVE;
    }, &state);
    Check(write(descriptors[1], "x", 1) == 1, "write pipe");
  });
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 5, false);
  worker.join();
  Check(state.events == 7, "timer, fd and worker delivery");
  g_source_unref(timer); g_source_unref(input);
  close(descriptors[0]); close(descriptors[1]);

  // Adding/removing native watches from BeforeWaiting can itself wake the
  // runloop forever. An idle context must really sleep, not continually rebuild
  // its descriptor watches. Measure turns, independently of machine CPU load.
  if (!round) {
    unsigned turns = 0;
    CFRunLoopObserverContext observerContext = {0, &turns, nullptr, nullptr, nullptr};
    auto observer = CFRunLoopObserverCreate(nullptr, kCFRunLoopBeforeWaiting, true, 1,
      [](CFRunLoopObserverRef, CFRunLoopActivity, void* data) { ++*static_cast<unsigned*>(data); }, &observerContext);
    CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, .2, false);
    CFRunLoopObserverInvalidate(observer); CFRelease(observer);
    fprintf(stderr, "Idle GLib runloop turns in 200ms: %u\n", turns);
    Check(turns < 100, "idle context does not spin native runloop");
  }

  // Releasing the last embedding owner inside a dispatched callback must not
  // delete the bridge until dispatch returns, nor leave native watches active.
  std::weak_ptr<WPEGLibRunLoop> witness = bridge;
  auto* close = g_idle_source_new();
  g_source_set_callback(close, [](void* data) -> gboolean {
    auto* owner = static_cast<std::shared_ptr<WPEGLibRunLoop>*>(data);
    owner->reset();
    CFRunLoopStop(CFRunLoopGetMain());
    return G_SOURCE_REMOVE;
  }, &bridge, nullptr);
  g_source_attach(close, context);
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 5, false);
  g_source_unref(close);
  Check(witness.expired(), "bridge released after callback");
  bool available = false;
  std::thread nextOwner([&] {
    available = g_main_context_acquire(context);
    if (available) g_main_context_release(context);
  });
  nextOwner.join();
  Check(available, "context released on destruction");
  }
  printf("PASS Darwin GLib timer, fd, cross-thread delivery and callback teardown: %u rounds\n", rounds);
}
