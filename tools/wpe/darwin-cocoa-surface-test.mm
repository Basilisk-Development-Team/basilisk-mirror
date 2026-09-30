/* Real WPE SHM -> AppKit presentation/lifetime fixture; no WebKit page. */
#import <AppKit/AppKit.h>
#include "WPECocoaSurface.h"
#include "WPECocoaClipboard.h"
#include "WPEGLibRunLoop.h"
#include <cstdio>

static bool PumpUntil(bool (*done)(void*), void* data)
{
  auto deadline = CFAbsoluteTimeGetCurrent() + 2;
  while (!done(data) && CFAbsoluteTimeGetCurrent() < deadline)
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
  return done(data);
}

struct Signals { unsigned rendered = 0, released = 0; bool dropOwner = false; };

int main()
{
  @autoreleasepool {
    [NSApplication sharedApplication];
    auto loop = WPEGLibRunLoop::Create(g_main_context_default());
    auto* display = WPECocoaDisplayNew();
    GError* error = nullptr;
    if (!wpe_display_connect(display, &error)) return 1;
    NSPasteboard* board = [NSPasteboard pasteboardWithUniqueName];
    [board setString:@"external Ω" forType:NSPasteboardTypeString];
    WPECocoaConfigureClipboard(display, board);
    WPECocoaImportClipboard(display);
    auto* clipboard = wpe_display_get_clipboard(display);
    gsize importedSize = 0;
    char* imported = wpe_clipboard_read_text(clipboard, "text/plain", &importedSize);
    if (!imported || strcmp(imported, "external Ω")) return 22;
    g_free(imported);
    auto* copied = wpe_clipboard_content_new();
    wpe_clipboard_content_set_text(copied, "WPE → Cocoa");
    wpe_clipboard_set_content(clipboard, copied);
    wpe_clipboard_content_unref(copied);
    if (![[board stringForType:NSPasteboardTypeString] isEqualToString:@"WPE → Cocoa"]) return 23;
    [board clearContents];
    WPECocoaImportClipboard(display);
    imported = wpe_clipboard_read_text(clipboard, "text/plain", &importedSize);
    if (imported) { g_free(imported); return 24; }
    puts("PASS named Cocoa clipboard: Unicode import/export and external clear");
    NSView* container = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 128, 128)];
    for (unsigned iteration = 0; iteration < 100; ++iteration) {
      auto* view = wpe_view_new(display);
      auto* native = WPECocoaViewNative(view);
      [native setFrame:[container bounds]];
      [container addSubview:native];
      gpointer witness = view;
      g_object_add_weak_pointer(G_OBJECT(view), &witness);
      Signals signals;
      g_signal_connect(view, "buffer-rendered", G_CALLBACK(+[](WPEView* view, WPEBuffer*, gpointer data) {
        auto* signals = static_cast<Signals*>(data);
        ++signals->rendered;
        if (signals->dropOwner) g_object_unref(view);
      }), &signals);
      g_signal_connect(view, "buffer-released", G_CALLBACK(+[](WPEView*, WPEBuffer*, gpointer data) {
        ++static_cast<Signals*>(data)->released;
      }), &signals);
      guint32 pixels[] = { 0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff };
      GBytes* bytes = g_bytes_new_static(pixels, sizeof(pixels));
      auto* invalid = wpe_buffer_shm_new(display, 2, 3, WPE_PIXEL_FORMAT_ARGB8888, bytes, 8);
      if (wpe_view_render_buffer(view, WPE_BUFFER(invalid), nullptr, 0, &error) || !error) return 11;
      g_clear_error(&error);
      g_object_unref(invalid); // Data is too short for three rows.
      invalid = wpe_buffer_shm_new(display, 2, 2, WPE_PIXEL_FORMAT_ARGB8888, bytes, 0);
      if (wpe_view_render_buffer(view, WPE_BUFFER(invalid), nullptr, 0, &error) || !error) return 12;
      g_clear_error(&error);
      g_object_unref(invalid);
      auto* buffer = wpe_buffer_shm_new(display, 2, 2, WPE_PIXEL_FORMAT_ARGB8888, bytes, 8);
      g_bytes_unref(bytes);
      if (!wpe_view_render_buffer(view, WPE_BUFFER(buffer), nullptr, 0, &error)) return 2;
      if (signals.rendered || signals.released) return 3; // Must not acknowledge inline.
      if (wpe_view_render_buffer(view, WPE_BUFFER(buffer), nullptr, 0, &error) || !error) return 4;
      g_clear_error(&error); // An outstanding frame is explicitly rejected.
      for (auto& pixel : pixels) pixel = 0; // Presentation must own its copy.
      // An explicit sRGB bitmap avoids relying on the desktop display profile
      // for this offscreen color assertion.
      NSBitmapImageRep* snapshot = [[[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:nullptr pixelsWide:128 pixelsHigh:128
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:512 bitsPerPixel:32] autorelease];
      snapshot = [snapshot bitmapImageRepByRetaggingWithColorSpace:[NSColorSpace sRGBColorSpace]];
      [native cacheDisplayInRect:[native bounds] toBitmapImageRep:snapshot];
      if (!snapshot) return 5;
      // Sample quadrant interiors using backing pixels, not logical points.
      NSInteger x = [snapshot pixelsWide] / 4;
      NSInteger y = [snapshot pixelsHigh] / 4;
      NSUInteger rawTop[4], rawBottom[4];
      [snapshot getPixel:rawTop atX:x y:y];
      [snapshot getPixel:rawBottom atX:x y:3*y];
      if (rawTop[0] != 255 || rawTop[1] || rawTop[2] || rawTop[3] != 255 ||
          rawBottom[0] || rawBottom[1] || rawBottom[2] != 255 || rawBottom[3] != 255) {
        fprintf(stderr, "raw pixels %lu,%lu,%lu,%lu / %lu,%lu,%lu,%lu\n",
          rawTop[0], rawTop[1], rawTop[2], rawTop[3],
          rawBottom[0], rawBottom[1], rawBottom[2], rawBottom[3]);
        return 6;
      }
      g_object_unref(buffer); // Pending presentation owns it now.
      if (iteration % 2) {
        signals.dropOwner = true;
        if (!PumpUntil([](void* data) { return !*static_cast<gpointer*>(data); }, &witness)) return 7;
        if (signals.rendered != 1 || signals.released != 1) return 8;
      } else {
        g_object_unref(view); // Cancel pending frame and detach immediately.
        if (witness || signals.rendered || signals.released) return 9;
      }
      if ([[container subviews] count]) return 10;
    }
    // Native event methods translate to WPE events and stop dispatching once
    // their owning view dies, even if AppKit retains the NSView temporarily.
    auto* inputView = wpe_view_new(display);
    auto* inputNative = [WPECocoaViewNative(inputView) retain];
    [inputNative setFrameSize:NSMakeSize(320, 240)];
    if (wpe_view_get_width(inputView) != 320 || wpe_view_get_height(inputView) != 240) return 13;
    if (![inputNative becomeFirstResponder] || !wpe_view_get_has_focus(inputView)) return 14;
    if (![inputNative resignFirstResponder] || wpe_view_get_has_focus(inputView)) return 15;
    struct InputState { unsigned count = 0; bool valid = true; bool destroy = false; } inputState;
    g_signal_connect(inputView, "event", G_CALLBACK(+[](WPEView* view, WPEEvent* event, gpointer data) -> gboolean {
      auto* state = static_cast<InputState*>(data);
      ++state->count;
      if (state->count == 1) {
        state->valid = wpe_event_get_event_type(event) == WPE_EVENT_POINTER_DOWN &&
          wpe_event_pointer_button_get_button(event) == 3 &&
          wpe_event_pointer_button_get_press_count(event) == 2 &&
          (wpe_event_get_modifiers(event) & WPE_MODIFIER_POINTER_BUTTON3) &&
          (wpe_event_get_modifiers(event) & WPE_MODIFIER_KEYBOARD_SHIFT);
      } else if (state->count == 2) {
        state->valid &= wpe_event_get_event_type(event) == WPE_EVENT_POINTER_UP &&
          !(wpe_event_get_modifiers(event) & WPE_MODIFIER_POINTER_BUTTON3);
      }
      if (state->destroy) g_object_unref(view);
      return TRUE;
    }), &inputState);
    // NS mouseEventWithType does not populate buttonNumber for right clicks.
    // Wrap native CoreGraphics events, as AppKit does for real mouse input.
    auto downCG = CGEventCreateMouseEvent(nullptr, kCGEventRightMouseDown,
      CGPointMake(10, 20), kCGMouseButtonRight);
    auto upCG = CGEventCreateMouseEvent(nullptr, kCGEventRightMouseUp,
      CGPointMake(10, 20), kCGMouseButtonRight);
    CGEventSetIntegerValueField(downCG, kCGMouseEventClickState, 2);
    CGEventSetFlags(downCG, kCGEventFlagMaskShift);
    NSEvent* down = [NSEvent eventWithCGEvent:downCG];
    NSEvent* up = [NSEvent eventWithCGEvent:upCG];
    CFRelease(downCG); CFRelease(upCG);
    [inputNative rightMouseDown:down];
    [inputNative rightMouseUp:up];
    if (!inputState.valid || inputState.count != 2) return 16;
    gpointer inputWitness = inputView;
    g_object_add_weak_pointer(G_OBJECT(inputView), &inputWitness);
    inputState.destroy = true;
    [inputNative rightMouseDown:down];
    if (inputWitness) return 17;
    [inputNative rightMouseDown:down]; // Retained native receiver has no backend.
    if (inputState.count != 3 || [inputNative acceptsFirstResponder]) return 18;
    [inputNative release];
    auto* dragView = wpe_view_new(display);
    bool dragButton = false;
    g_signal_connect(dragView, "event", G_CALLBACK(+[](WPEView*, WPEEvent* event, gpointer data) -> gboolean {
      *static_cast<bool*>(data) = wpe_event_get_event_type(event) == WPE_EVENT_POINTER_MOVE &&
        (wpe_event_get_modifiers(event) & WPE_MODIFIER_POINTER_BUTTON1);
      return TRUE;
    }), &dragButton);
    NSEvent* drag = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:NSMakePoint(30, 10)
      modifierFlags:0 timestamp:1 windowNumber:0 context:nil eventNumber:0 clickCount:1 pressure:0];
    [WPECocoaViewNative(dragView) mouseDragged:drag];
    if (!dragButton) return 33;
    g_object_unref(dragView);
    auto* rightView = wpe_view_new(display);
    bool rightButton = false;
    g_signal_connect(rightView, "event", G_CALLBACK(+[](WPEView*, WPEEvent* event, gpointer data) -> gboolean {
      *static_cast<bool*>(data) = wpe_event_get_event_type(event) == WPE_EVENT_POINTER_DOWN &&
        wpe_event_pointer_button_get_button(event) == 3;
      return TRUE;
    }), &rightButton);
    NSEvent* right = [NSEvent mouseEventWithType:NSEventTypeRightMouseDown location:NSMakePoint(30, 10)
      modifierFlags:0 timestamp:1 windowNumber:0 context:nil eventNumber:0 clickCount:1 pressure:0];
    [WPECocoaViewNative(rightView) rightMouseDown:right];
    if (!rightButton) return 34;
    g_object_unref(rightView);
    // Browser commands must not be delivered as page keystrokes. Closing the
    // view from a command must also invalidate the retained native receiver.
    auto* commandView = wpe_view_new(display);
    auto* commandNative = [WPECocoaViewNative(commandView) retain];
    struct CommandState { WPEView* view; unsigned calls = 0; bool valid = true; } commands { commandView };
    unsigned pageKeys = 0;
    g_signal_connect(commandView, "event", G_CALLBACK(+[](WPEView*, WPEEvent*, gpointer data) -> gboolean {
      ++*static_cast<unsigned*>(data); return TRUE;
    }), &pageKeys);
    WPECocoaViewSetCommand(commandView, [](const char* command, void* data) {
      auto* state = static_cast<CommandState*>(data);
      ++state->calls;
      state->valid &= !strcmp(command, state->calls == 1 ? "location" : "close-tab");
      if (state->calls == 2) g_object_unref(state->view);
    }, &commands);
    auto key = [](NSEventType type, NSString* text, unsigned code) {
      return [NSEvent keyEventWithType:type location:NSZeroPoint
        modifierFlags:NSEventModifierFlagCommand timestamp:1 windowNumber:0
        context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];
    };
    [commandNative keyDown:key(NSEventTypeKeyDown, @"l", 37)];
    [commandNative keyUp:key(NSEventTypeKeyUp, @"l", 37)];
    if (!commands.valid || commands.calls != 1 || pageKeys) return 19;
    gpointer commandWitness = commandView;
    g_object_add_weak_pointer(G_OBJECT(commandView), &commandWitness);
    [commandNative keyDown:key(NSEventTypeKeyDown, @"w", 13)];
    if (commandWitness || !commands.valid || commands.calls != 2) return 20;
    [commandNative keyDown:key(NSEventTypeKeyDown, @"l", 37)];
    if (commands.calls != 2 || pageKeys) return 21;
    [commandNative release];
    // A chrome command may move first responder, so its release goes to
    // chrome. Suppression must not survive and eat a later page key release.
    auto* refocused = wpe_view_new(display);
    auto* refocusedNative = WPECocoaViewNative(refocused);
    unsigned released = 0;
    g_signal_connect(refocused, "event", G_CALLBACK(+[](WPEView*, WPEEvent* event, gpointer data) -> gboolean {
      if (wpe_event_get_event_type(event) == WPE_EVENT_KEYBOARD_KEY_UP) ++*static_cast<unsigned*>(data);
      return TRUE;
    }), &released);
    WPECocoaViewSetCommand(refocused, [](const char*, void*) {}, nullptr);
    [refocusedNative keyDown:key(NSEventTypeKeyDown, @"l", 37)];
    [refocusedNative resignFirstResponder];
    [refocusedNative becomeFirstResponder];
    [refocusedNative keyUp:key(NSEventTypeKeyUp, @"l", 37)];
    if (released != 1) return 25;
    g_object_unref(refocused);
    // Public composition signals use the same lifetime boundary as keys. A
    // context may outlive its WPEView; the retained AppKit receiver must become
    // inert, and disposing the context must clear its borrowed native binding.
    auto* compositionView = wpe_view_new(display);
    auto* compositionNative = [WPECocoaViewNative(compositionView) retain];
    auto* inputContext = wpe_input_method_context_new(compositionView);
    id<NSTextInputClient> client = (id<NSTextInputClient>)compositionNative;
    unsigned commits = 0;
    g_signal_connect(inputContext, "committed", G_CALLBACK(+[](WPEInputMethodContext*, const char* text, gpointer data) {
      if (!strcmp(text, "確定")) ++*static_cast<unsigned*>(data);
    }), &commits);
    wpe_input_method_context_set_surrounding(inputContext, "Ωab", 4, 3, 3);
    wpe_input_method_context_focus_out(inputContext);
    if (!NSEqualRanges([client selectedRange], NSMakeRange(2, 0))) return 30;
    [client setMarkedText:@"仮名" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    if (!NSEqualRanges([client markedRange], NSMakeRange(2, 2))) return 31;
    wpe_input_method_context_set_surrounding(inputContext, "Ωa仮名b", 10, 9, 9);
    if (!NSEqualRanges([client markedRange], NSMakeRange(2, 2))) return 32;
    char* preedit = nullptr; guint cursor = 0;
    wpe_input_method_context_get_preedit_string(inputContext, &preedit, nullptr, &cursor);
    if (strcmp(preedit, "仮名") || cursor != 2 || ![client hasMarkedText]) return 26;
    g_free(preedit);
    [client insertText:@"確定" replacementRange:NSMakeRange(NSNotFound, 0)];
    if (commits != 1 || [client hasMarkedText]) return 27;
    [client setMarkedText:@"仮" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    g_object_unref(compositionView);
    [client insertText:@"確定" replacementRange:NSMakeRange(NSNotFound, 0)];
    if (commits != 1 || [client hasMarkedText]) return 28;
    g_object_unref(inputContext);
    [client setMarkedText:@"仮" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    if ([client hasMarkedText]) return 29;
    [compositionNative release];
    puts("PASS native composition context/view lifetime and stale receiver");
    // Drain past the last cancelled frame's deadline; a stale source would call
    // freed stack/object data. The deadline bounds observation, not production.
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.03, false);
    [container release];
    g_object_unref(display);
    loop.reset();
    [board releaseGlobally];
    puts("PASS Cocoa WPE SHM color/row presentation, deferred acknowledgement, pending close and callback destruction: 100 cycles; native pointer/focus/resize/lifetime checks");
  }
}
