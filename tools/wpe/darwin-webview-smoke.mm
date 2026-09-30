// Standalone WPE WebProcess/presentation bring-up. Not a Basilisk UI test.
#import <AppKit/AppKit.h>
#include "WPECocoaSurface.h"
#include "WPEGLibRunLoop.h"
#include <wpe/webkit.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <string>

struct TestState {
  bool loaded = false;
  bool failed = false;
  unsigned frames = 0;
  std::string mainFrame;
  std::string message;
};

static int RunView(int argc, char** argv)
{
  @autoreleasepool {
    [NSApplication sharedApplication];
    auto loop = WPEGLibRunLoop::Create(g_main_context_default());
    auto* display = WPECocoaDisplayNew();
    GError* error = nullptr;
    if (!wpe_display_connect(display, &error)) {
      fprintf(stderr, "Display: %s\n", error ? error->message : "failed");
      g_clear_error(&error);
      g_object_unref(display);
      return 1;
    }
    if (const char* extensions = getenv("WPE_SMOKE_EXTENSION_PATH"))
      webkit_web_context_set_web_process_extensions_directory(webkit_web_context_get_default(), extensions);
    auto* session = webkit_network_session_new_ephemeral();
    auto* web = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW,
      "display", display, "network-session", session, nullptr));
    g_object_unref(session);
    auto* view = webkit_web_view_get_wpe_view(web);
    auto* top = wpe_display_create_toplevel(display, 1);
    wpe_view_set_toplevel(view, top);
    wpe_toplevel_resized(top, 640, 480);
    wpe_view_resized(view, 640, 480);
    auto* native = WPECocoaViewNative(view);
    [native setFrame:NSMakeRect(0, 0, 640, 480)];
    NSWindow* window = [[NSWindow alloc] initWithContentRect:[native frame]
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    [window setContentView:native];
    wpe_view_set_visible(view, TRUE);
    wpe_view_map(view);
    TestState state;
    g_signal_connect(web, "user-message-received", G_CALLBACK(+[](WebKitWebView*, WebKitUserMessage* message, gpointer data) -> gboolean {
      auto* state = static_cast<TestState*>(data);
      auto* parameters = webkit_user_message_get_parameters(message);
      if (!strcmp(webkit_user_message_get_name(message), "basilisk:frame-created")) {
        const char *token; const char *uri; const char *parent; gboolean main;
        g_variant_get(parameters, "(&s&sb&s)", &token, &uri, &main, &parent);
        if (main) state->mainFrame = token;
        return TRUE;
      }
      if (!strcmp(webkit_user_message_get_name(message), "basilisk:frame-message")) {
        const char *token; const char *uri; const char *json; gboolean main;
        g_variant_get(parameters, "(&s&sb&s)", &token, &uri, &main, &json);
        if (main && state->mainFrame == token) state->message = json;
        return TRUE;
      }
      return FALSE;
    }), &state);
    g_signal_connect(web, "load-changed", G_CALLBACK(+[](WebKitWebView* web, WebKitLoadEvent event, gpointer data) {
      fprintf(stderr, "load event=%d uri=%s title=%s\n", event,
        webkit_web_view_get_uri(web) ?: "", webkit_web_view_get_title(web) ?: "");
      if (event == WEBKIT_LOAD_FINISHED) static_cast<TestState*>(data)->loaded = true;
    }), &state);
    g_signal_connect(web, "load-failed", G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent, const char* uri, GError* error, gpointer data) -> gboolean {
      fprintf(stderr, "load failed: %s: %s\n", uri, error->message);
      static_cast<TestState*>(data)->failed = true;
      return TRUE;
    }), &state);
    g_signal_connect(web, "web-process-terminated", G_CALLBACK(+[](WebKitWebView*, WebKitWebProcessTerminationReason reason, gpointer data) {
      fprintf(stderr, "WebProcess terminated: %d\n", reason);
      static_cast<TestState*>(data)->failed = true;
    }), &state);
    g_signal_connect(view, "buffer-rendered", G_CALLBACK(+[](WPEView*, WPEBuffer*, gpointer data) {
      ++static_cast<TestState*>(data)->frames;
    }), &state);
    if (argc > 1)
      webkit_web_view_load_uri(web, argv[1]);
    else
      webkit_web_view_load_html(web,
        "<!doctype html><title>WPE Darwin render</title>"
        "<style>html,body{margin:0;background:rgb(51,102,153);height:2000px}"
        "button{position:absolute;left:10px;top:10px;width:80px;height:30px}</style>"
        "<button onclick=\"document.title='clicked';document.getElementById('entry').focus()\">click</button>"
        "<input id=entry style=\"position:absolute;left:100px;top:10px;width:150px\">"
        "<script>let lastCode;entry.onkeydown=e=>lastCode=e.code;"
        "entry.oninput=()=>document.title='typed:'+entry.value+':'+lastCode;"
        "onresize=()=>document.title='size:'+innerWidth;"
        "onscroll=()=>document.title='scroll:'+scrollY;</script>", nullptr);
    auto deadline = CFAbsoluteTimeGetCurrent() + 45;
    bool pixelsMatch = false;
    while (!state.failed && CFAbsoluteTimeGetCurrent() < deadline) {
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
      if (!state.loaded || !state.frames) continue;
      if (argc > 1) break;
      NSBitmapImageRep* bitmap = [[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
        pixelsWide:640 pixelsHigh:480 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
        isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:2560 bitsPerPixel:32] autorelease];
      bitmap = [bitmap bitmapImageRepByRetaggingWithColorSpace:[NSColorSpace sRGBColorSpace]];
      [native cacheDisplayInRect:[native bounds] toBitmapImageRep:bitmap];
      NSUInteger pixel[4];
      [bitmap getPixel:pixel atX:320 y:240];
      pixelsMatch = pixel[0] == 51 && pixel[1] == 102 && pixel[2] == 153 && pixel[3] == 255;
      if (pixelsMatch) break;
    }
    bool passed = !state.failed && state.loaded && state.frames && (argc > 1 || pixelsMatch);
    if (passed && getenv("WPE_SMOKE_EXPECT_TITLE")) {
      const char* expected = getenv("WPE_SMOKE_EXPECT_TITLE");
      passed = false;
      auto deadline = CFAbsoluteTimeGetCurrent() + 30;
      while (!state.failed && CFAbsoluteTimeGetCurrent() < deadline) {
        const char* title = webkit_web_view_get_title(web);
        if (title && !strcmp(title, expected)) { passed = true; break; }
        if (title && !strncmp(title, "FAIL ", 5)) break;
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
      }
      fprintf(stderr, "%s asynchronous page result: %s\n", passed ? "PASS" : "FAIL",
        webkit_web_view_get_title(web) ?: "(null)");
    }
    if (passed && argc == 1) {
      auto waitTitle = [&](const char* title, bool prefix = false) {
        auto deadline = CFAbsoluteTimeGetCurrent() + 5;
        while (!state.failed && CFAbsoluteTimeGetCurrent() < deadline) {
          auto* actual = webkit_web_view_get_title(web);
          if (actual && (prefix ? !strncmp(actual, title, strlen(title)) : !strcmp(actual, title))) return true;
          CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
        }
        fprintf(stderr, "Expected title %s, got %s\n", title, webkit_web_view_get_title(web) ?: "(null)");
        return false;
      };
      NSPoint point = [native convertPoint:NSMakePoint(20, 20) toView:nil];
      auto* down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:point
        modifierFlags:0 timestamp:1 windowNumber:[window windowNumber] context:nil
        eventNumber:1 clickCount:1 pressure:1];
      auto* up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:point
        modifierFlags:0 timestamp:1.1 windowNumber:[window windowNumber] context:nil
        eventNumber:2 clickCount:1 pressure:0];
      [native mouseDown:down]; [native mouseUp:up];
      passed = waitTitle("clicked");
      if (passed) {
        auto type = [&](NSString* characters, unsigned short code, NSEventModifierFlags flags) {
          auto* press = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
            modifierFlags:flags timestamp:2 windowNumber:[window windowNumber] context:nil
            characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:code];
          auto* release = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint
            modifierFlags:flags timestamp:2.1 windowNumber:[window windowNumber] context:nil
            characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:code];
          [native keyDown:press]; [native keyUp:release];
        };
        type(@"a", 0, 0);
        passed = waitTitle("typed:a:KeyA");
        if (passed) { type(@"A", 0, NSEventModifierFlagShift); passed = waitTitle("typed:aA:KeyA"); }
        if (passed) { type(@"\177", 51, 0); passed = waitTitle("typed:a:Backspace"); }
      }
      if (passed) {
        [native setFrameSize:NSMakeSize(400, 300)];
        passed = waitTitle("size:400");
      }
      if (passed) {
        auto scroll = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 1, -120);
        [native scrollWheel:[NSEvent eventWithCGEvent:scroll]];
        CFRelease(scroll);
        passed = waitTitle("scroll:", true);
      }
      fprintf(stderr, "%s WPE page native click/keyboard/resize/scroll callbacks\n", passed ? "PASS" : "FAIL");
    }
    if (passed && getenv("WPE_SMOKE_EXTENSION_PATH")) {
      struct Reply { bool done = false; std::string json, error; };
      auto request = [&](const char* name, GVariant* parameters) {
        auto result = std::make_shared<Reply>();
        webkit_web_view_send_message_to_page(web, webkit_user_message_new(name, parameters), nullptr,
          +[](GObject* source, GAsyncResult* operation, gpointer data) {
            std::unique_ptr<std::shared_ptr<Reply>> owner(static_cast<std::shared_ptr<Reply>*>(data));
            auto result = *owner;
            GError* error = nullptr;
            auto* reply = webkit_web_view_send_message_to_page_finish(WEBKIT_WEB_VIEW(source), operation, &error);
            if (error) { result->error = error->message; g_error_free(error); }
            else if (reply) {
              const char *json, *message;
              g_variant_get(webkit_user_message_get_parameters(reply), "(&s&s)", &json, &message);
              result->json = json; result->error = message;
              g_object_unref(reply);
            }
            result->done = true;
          }, new std::shared_ptr<Reply>(result));
        auto deadline = CFAbsoluteTimeGetCurrent() + 5;
        while (!result->done && CFAbsoluteTimeGetCurrent() < deadline)
          CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
        if (!result->done) result->error = "Fixture reply timeout";
        if (!result->error.empty()) fprintf(stderr, "Bridge %s: %s\n", name, result->error.c_str());
        return result;
      };
      passed = !state.mainFrame.empty();
      if (passed) {
        auto initialized = request("basilisk:world-execute", g_variant_new("(usssb)",
          1u, state.mainFrame.c_str(), "darwin-fixture", "var persistentValue = 41;", TRUE));
        auto ordered = request("basilisk:world-execute", g_variant_new("(usssb)",
          2u, state.mainFrame.c_str(), "darwin-fixture", "return ++persistentValue;", FALSE));
        auto isolated = request("basilisk:world-execute", g_variant_new("(usssb)",
          3u, state.mainFrame.c_str(), "other-fixture", "return typeof persistentValue;", FALSE));
        auto dom = request("basilisk:execute", g_variant_new("(uss)", 4u, state.mainFrame.c_str(),
          "browserContent.sendMessage({ping:7}); return document.querySelector('button').textContent;"));
        passed = initialized->error.empty() && ordered->error.empty() && ordered->json == "42" &&
          isolated->error.empty() && isolated->json == "\"undefined\"" &&
          dom->error.empty() && dom->json == "\"click\"";
        auto deadline = CFAbsoluteTimeGetCurrent() + 5;
        while (state.message.empty() && CFAbsoluteTimeGetCurrent() < deadline)
          CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
        passed &= state.message == "{\"ping\":7}";
      }
      if (passed) {
        // Exercise both directions above the inline IPC/socket payload size.
        // The source remains below the production bridge's 1 MiB bound.
        std::string source = "/*" + std::string(512 * 1024, 'x') +
          "*/ return 'y'.repeat(256 * 1024);";
        auto large = request("basilisk:execute", g_variant_new("(uss)",
          7u, state.mainFrame.c_str(), source.c_str()));
        passed = large->error.empty() && large->json == "\"" + std::string(256 * 1024, 'y') + "\"";
        fprintf(stderr, "%s large content IPC round trip\n", passed ? "PASS" : "FAIL");
      }
      if (passed) {
        std::string previousFrame = state.mainFrame;
        state.loaded = false;
        state.mainFrame.clear();
        webkit_web_view_reload(web);
        auto deadline = CFAbsoluteTimeGetCurrent() + 5;
        while ((!state.loaded || state.mainFrame.empty()) && !state.failed && CFAbsoluteTimeGetCurrent() < deadline)
          CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
        passed = state.loaded && !state.failed && !state.mainFrame.empty() && state.mainFrame != previousFrame;
        if (passed) {
          auto stale = request("basilisk:execute", g_variant_new("(uss)", 5u,
            previousFrame.c_str(), "return 99;"));
          auto fresh = request("basilisk:world-execute", g_variant_new("(usssb)", 6u,
            state.mainFrame.c_str(), "darwin-fixture", "return typeof persistentValue;", FALSE));
          passed = stale->error == "Unknown or expired frame" && fresh->error.empty() && fresh->json == "\"undefined\"";
        }
      }
      fprintf(stderr, "%s unchanged content bridge: frame, ordered world, isolation, DOM, JSON message and reload invalidation\n", passed ? "PASS" : "FAIL");
    }
    fprintf(stderr, "%s WPE Darwin web view: loaded=%d frames=%u pixels=%d\n",
      passed ? "PASS" : "FAIL", state.loaded, state.frames, pixelsMatch);
    g_signal_handlers_disconnect_by_data(web, &state);
    g_signal_handlers_disconnect_by_data(view, &state);
    webkit_web_view_stop_loading(web);
    wpe_view_unmap(view);
    wpe_view_set_toplevel(view, nullptr);
    [native removeFromSuperview];
    [window close];
    [window release];
    g_object_unref(web);
    g_object_unref(top);
    g_object_unref(display);
    loop.reset();
    return passed ? 0 : 2;
  }
}

int main(int argc, char** argv)
{
  const char* count = getenv("WPE_SMOKE_CYCLES");
  unsigned cycles = count ? strtoul(count, nullptr, 10) : 1;
  if (!cycles || cycles > 1000) return 3;
  for (unsigned i = 0; i < cycles; ++i) {
    fprintf(stderr, "WPE view cycle %u/%u\n", i + 1, cycles);
    if (int result = RunView(argc, argv)) return result;
  }
  return 0;
}
