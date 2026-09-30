// Exercise the browser-facing native host boundary without XUL/UXP changes.
#import <AppKit/AppKit.h>
#include "../../basilisk/components/contentengine/wpe/WPEHost.h"
#include "../../basilisk/components/contentengine/wpe/WPEHostPlatform.h"
#include "WPECocoaSurface.h"
#include "WPECocoaClipboard.h"
#include <cstdio>
#include <cstdlib>

struct Owner {
  WPEHost* host;
  WPEHostWindow* window;
  unsigned frames = 0;
  bool loaded = false;
  bool closed = false;
};
static void Close(void* data)
{
  auto* owner = static_cast<Owner*>(data);
  auto* host = owner->host;
  owner->host = nullptr;
  owner->closed = true;
  g_signal_handlers_disconnect_by_data(host->webView, owner);
  g_signal_handlers_disconnect_by_data(host->view, owner);
  wpe_host_free(host);
  wpe_host_window_free(owner->window);
  owner->window = nullptr;
}
int main(int argc, char** argv)
{
  [NSApplication sharedApplication];
  unsigned cycles = getenv("WPE_SMOKE_CYCLES") ? atoi(getenv("WPE_SMOKE_CYCLES")) : 1;
  for (unsigned i = 0; i < cycles; ++i) {
    @autoreleasepool {
      NSWindow* window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,640,480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
      [window setReleasedWhenClosed:NO];
      Owner owner;
      owner.window = wpe_host_window_new([window contentView]);
      if (!owner.window) return 1;
      auto* session = webkit_network_session_new_ephemeral();
      wpe_host_window_set_session(owner.window, "default", session);
      if (wpe_host_window_session(owner.window, "default") != session) return 2;
      auto* containerSession = webkit_network_session_new_ephemeral();
      wpe_host_window_set_session(owner.window, "container-1", containerSession);
      if (wpe_host_window_session(owner.window, "container-1") != containerSession ||
          wpe_host_window_session(owner.window, "default") != session) return 25;
      g_object_unref(containerSession);
      owner.host = wpe_host_new(session);
      g_object_unref(session);
      if (!owner.host || !wpe_host_mount(owner.host, owner.window, Close, &owner)) return 3;
      NSPasteboard* board = [NSPasteboard pasteboardWithUniqueName];
      WPECocoaConfigureClipboard(owner.host->display, board);
      auto* native = WPECocoaViewNative(owner.host->view);
      if ([native superview] != [window contentView]) return 4;
      wpe_host_set_bounds(owner.host, owner.window, 0, 0, 640, 480);
      wpe_host_set_visible(owner.host, true);
      g_signal_connect(owner.host->webView, "load-changed", G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent event, gpointer data) {
        if (event == WEBKIT_LOAD_FINISHED) static_cast<Owner*>(data)->loaded = true;
      }), &owner);
      g_signal_connect(owner.host->view, "buffer-rendered", G_CALLBACK(+[](WPEView*, WPEBuffer*, gpointer data) {
        ++static_cast<Owner*>(data)->frames;
      }), &owner);
      if (argc > 1) webkit_web_view_load_uri(owner.host->webView, argv[1]);
      else webkit_web_view_load_html(owner.host->webView, "<title>Host fixture</title><input id=edit value='WPE clipboard'><script>edit.focus();edit.oninput=()=>document.title='input:'+edit.value;</script>", nullptr);
      auto deadline = CFAbsoluteTimeGetCurrent() + 30;
      while (owner.host && (!owner.loaded || !owner.frames) && CFAbsoluteTimeGetCurrent() < deadline)
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
      if (!owner.host || !owner.loaded || !owner.frames) return 5;
      wpe_host_focus(owner.host);
      if (!wpe_host_has_focus(owner.host)) return 6;
      if (argc == 1) {
        auto pump = [&](auto predicate) {
          auto end = CFAbsoluteTimeGetCurrent() + 5;
          while (!predicate() && CFAbsoluteTimeGetCurrent() < end)
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
          return predicate();
        };
        wpe_host_execute_editing_command(owner.host, "SelectAll");
        wpe_host_execute_editing_command(owner.host, "Copy");
        if (!pump([&] { return [[board stringForType:NSPasteboardTypeString] isEqualToString:@"WPE clipboard"]; })) return 9;
        [board clearContents];
        [board setString:@"external Ω" forType:NSPasteboardTypeString];
        wpe_host_execute_editing_command(owner.host, "Paste");
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:external Ω"); })) return 10;
        auto command = [&](NSString* text, unsigned code) {
          [native keyDown:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
            modifierFlags:NSEventModifierFlagCommand timestamp:1 windowNumber:window.windowNumber
            context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code]];
        };
        command(@"a", 0); command(@"x", 7);
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:"); })) return 11;
        if (![[board stringForType:NSPasteboardTypeString] isEqualToString:@"external Ω"]) return 12;
        if (![native conformsToProtocol:@protocol(NSTextInputClient)]) return 13;
        id<NSTextInputClient> client = (id<NSTextInputClient>)native;
        [client setMarkedText:@"仮" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:仮"); })) return 14;
        [client setMarkedText:@"仮名" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:仮名"); })) return 15;
        [client insertText:@"確定" replacementRange:NSMakeRange(NSNotFound, 0)];
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:確定"); })) return 16;
        fprintf(stderr, "PASS native WPE marked text update and commit\n");
        auto plainKey = [&](NSString* text, unsigned code, NSEventModifierFlags modifiers) {
          [native keyDown:[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
            modifierFlags:modifiers timestamp:2 windowNumber:window.windowNumber
            context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code]];
        };
        plainKey(@"a", 0, 0);
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:確定a"); })) { fprintf(stderr, "Unexpected post-composition key title: %s\n", webkit_web_view_get_title(owner.host->webView)); return 17; }
        plainKey(@"A", 0, NSEventModifierFlagShift);
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:確定aA"); })) return 18;
        plainKey(@"\x7f", 51, 0);
        if (!pump([&] { return !g_strcmp0(webkit_web_view_get_title(owner.host->webView), "input:確定a"); })) return 19;
        fprintf(stderr, "PASS ordinary keys after native composition\n");
        fprintf(stderr, "PASS native WPE page copy/paste and Command-A/X against a named pasteboard\n");
      }
      if (getenv("WPE_SMOKE_INSPECTOR") && *getenv("WPE_SMOKE_INSPECTOR")) {
        struct Inspector { WPEView* view = nullptr; unsigned count = 0; } inspector;
        owner.host->chromeData = &inspector;
        owner.host->inspectorCreated = [](WPEView* view, void* data) {
          auto* inspector = static_cast<Inspector*>(data);
          ++inspector->count;
          inspector->view = WPE_VIEW(g_object_ref(view));
        };
        webkit_settings_set_enable_developer_extras(webkit_web_view_get_settings(owner.host->webView), TRUE);
        wpe_host_inspector_action(owner.host);
        if (inspector.count != 1 || !inspector.view || inspector.view == owner.host->view) return 21;
        auto end = CFAbsoluteTimeGetCurrent() + 15;
        while (!wpe_view_get_toplevel(inspector.view) && CFAbsoluteTimeGetCurrent() < end)
          CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
        if (!wpe_view_get_toplevel(inspector.view)) return 22;
        wpe_view_closed(inspector.view);
        g_object_unref(inspector.view);
        owner.host->chromeData = nullptr; owner.host->inspectorCreated = nullptr;
        fprintf(stderr, "PASS related view excluded from Inspector callback; synchronous Inspector owner and close\n");
      }
      wpe_host_set_visible(owner.host, false);
      if (wpe_host_has_focus(owner.host) || ![native isHidden]) return 7;
      wpe_host_set_visible(owner.host, true);
      // Exercise the native close fallback; browser session ownership is tested in XUL.
      [window close];
      if (!owner.closed || owner.host || owner.window || [[window contentView] subviews].count) return 8;
      [window release];
      [board releaseGlobally];
      fprintf(stderr, "PASS WPE native host window/session/mount/load/focus/hide/close %u/%u\n", i + 1, cycles);
    }
  }
  return 0;
}
