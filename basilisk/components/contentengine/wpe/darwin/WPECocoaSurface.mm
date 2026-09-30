/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPECocoaSurface.h"
#include "WPECocoaClipboard.h"
#import <AppKit/AppKit.h>
#include <IOKit/hidsystem/IOLLEvent.h>
#include <wpe/WPEKeysyms.h>
#include <xkbcommon/xkbcommon.h>

@interface WPEFrameView : NSView <NSTextInputClient> {
  CGImageRef mImage;
  WPEView* mOwner; // Borrowed; cleared before the owning GObject releases us.
  NSTrackingArea* mTracking;
  void (*mCommand)(const char*, void*);
  void* mCommandData;
  bool mCommandKeys[128];
  WPEInputMethodContext* mInput; // Borrowed; context clears this before disposal.
  NSEvent* mKeyEvent; // Borrowed for the synchronous WPE key-filter call only.
  NSString* mMarked;
  NSString* mSurrounding;
  NSRange mSelection;
  NSRange mMarkedSelection;
  NSUInteger mMarkedStart;
  NSRect mCursor;
  bool mInputHandled;
}
- (void)setFrameImage:(CGImageRef)image;
- (void)setOwner:(WPEView*)owner;
- (void)setCommand:(void (*)(const char*, void*))callback data:(void*)data;
- (void)setInputMethod:(WPEInputMethodContext*)context;
- (BOOL)filterInput;
- (void)resetInput;
- (void)copyPreedit:(char**)text cursor:(guint*)cursor;
- (void)setSurrounding:(NSString*)text selection:(NSRange)selection;
- (void)setCursor:(NSRect)rect;
@end

static WPEModifiers EventModifiers(NSEvent* event, NSUInteger buttons)
{
  unsigned flags = 0;
  auto modifiers = [event modifierFlags];
  if (modifiers & NSEventModifierFlagShift) flags |= WPE_MODIFIER_KEYBOARD_SHIFT;
  if (modifiers & NSEventModifierFlagControl) flags |= WPE_MODIFIER_KEYBOARD_CONTROL;
  if (modifiers & NSEventModifierFlagOption) flags |= WPE_MODIFIER_KEYBOARD_ALT;
  if (modifiers & NSEventModifierFlagCommand) flags |= WPE_MODIFIER_KEYBOARD_META;
  if (modifiers & NSEventModifierFlagCapsLock) flags |= WPE_MODIFIER_KEYBOARD_CAPS_LOCK;
  // Cocoa numbers right/middle as 1/2; WPE numbers middle/right as 2/3.
  if (buttons & 1) flags |= WPE_MODIFIER_POINTER_BUTTON1;
  if (buttons & 2) flags |= WPE_MODIFIER_POINTER_BUTTON3;
  if (buttons & 4) flags |= WPE_MODIFIER_POINTER_BUTTON2;
  if (buttons & 8) flags |= WPE_MODIFIER_POINTER_BUTTON4;
  if (buttons & 16) flags |= WPE_MODIFIER_POINTER_BUTTON5;
  return static_cast<WPEModifiers>(flags);
}

static guint32 EventTime(NSEvent* event)
{
  return static_cast<guint32>(static_cast<uint64_t>([event timestamp] * 1000));
}

// WPE's existing keyboard contract uses XKB hardware codes (evdev + 8).
// AppKit supplies stable virtual key positions independently of keyboard layout;
// characters come separately from the active AppKit layout below.
static guint HardwareKeyCode(unsigned code)
{
  static const guint positions[64] = {
    38,39,40,41,43,42,52,53,54,55,94,56,24,25,26,27,
    29,28,10,11,12,13,15,14,21,18,16,20,17,19,35,32,
    30,34,31,33,36,46,44,48,45,47,51,59,61,57,58,60,
    23,65,49,22,0,9,134,133,50,66,64,37,62,108,105,0
  };
  if (code < 64) return positions[code];
  switch (code) {
    case 65: return 91; // Keypad decimal.
    case 67: return 63; case 69: return 86; case 71: return 77;
    case 75: return 106; case 76: return 104; case 78: return 82;
    case 81: return 125; case 82: return 90; case 83: return 87;
    case 84: return 88; case 85: return 89; case 86: return 83;
    case 87: return 84; case 88: return 85; case 89: return 79;
    case 91: return 80; case 92: return 81;
    case 96: return 71; case 97: return 72; case 98: return 73;
    case 99: return 69; case 100: return 74; case 101: return 75;
    case 103: return 95; case 109: return 76; case 111: return 96;
    case 114: return 118; case 115: return 110; case 116: return 112;
    case 117: return 119; case 118: return 70; case 119: return 115;
    case 120: return 68; case 121: return 117; case 122: return 67;
    case 123: return 113; case 124: return 114; case 125: return 116;
    case 126: return 111;
    default: return 0; // WPE reports an unknown physical position truthfully.
  }
}

static guint KeyValue(NSEvent* event)
{
  switch ([event keyCode]) {
    case 36: return WPE_KEY_Return; case 48: return WPE_KEY_Tab;
    case 51: return WPE_KEY_BackSpace; case 53: return WPE_KEY_Escape;
    case 54: return WPE_KEY_Super_R; case 55: return WPE_KEY_Super_L;
    case 56: return WPE_KEY_Shift_L; case 57: return WPE_KEY_Caps_Lock;
    case 58: return WPE_KEY_Alt_L; case 59: return WPE_KEY_Control_L;
    case 60: return WPE_KEY_Shift_R; case 61: return WPE_KEY_Alt_R;
    case 62: return WPE_KEY_Control_R; case 76: return WPE_KEY_KP_Enter;
    case 96: return WPE_KEY_F5; case 97: return WPE_KEY_F6;
    case 98: return WPE_KEY_F7; case 99: return WPE_KEY_F3;
    case 100: return WPE_KEY_F8; case 101: return WPE_KEY_F9;
    case 103: return WPE_KEY_F11; case 109: return WPE_KEY_F10;
    case 111: return WPE_KEY_F12; case 114: return WPE_KEY_Help;
    case 115: return WPE_KEY_Home; case 116: return WPE_KEY_Page_Up;
    case 117: return WPE_KEY_Delete; case 118: return WPE_KEY_F4;
    case 119: return WPE_KEY_End; case 120: return WPE_KEY_F2;
    case 121: return WPE_KEY_Page_Down; case 122: return WPE_KEY_F1;
    case 123: return WPE_KEY_Left; case 124: return WPE_KEY_Right;
    case 125: return WPE_KEY_Down; case 126: return WPE_KEY_Up;
  }
  NSString* text = ([event modifierFlags] & (NSEventModifierFlagControl | NSEventModifierFlagCommand))
    ? [event charactersIgnoringModifiers] : [event characters];
  if (![text length]) return WPE_KEY_VoidSymbol;
  uint32_t character = [text characterAtIndex:0];
  if ([text length] == 2 && CFStringIsSurrogateHighCharacter(character) &&
      CFStringIsSurrogateLowCharacter([text characterAtIndex:1]))
    character = CFStringGetLongCharacterForSurrogatePair(character, [text characterAtIndex:1]);
  else if ([text length] != 1) return WPE_KEY_VoidSymbol;
  return xkb_utf32_to_keysym(character);
}

@implementation WPEFrameView
- (void)setInputMethod:(WPEInputMethodContext*)context {
  mInput = context;
  [mSurrounding release]; mSurrounding = nil;
  mSelection = NSMakeRange(NSNotFound, 0);
}
- (BOOL)filterInput {
  if (!mOwner || !mInput || !mKeyEvent) return NO;
  mInputHandled = true;
  [self interpretKeyEvents:@[mKeyEvent]];
  return mInputHandled;
}
- (void)resetInput {
  [mMarked release]; mMarked = nil;
  // WebKit sends surrounding text only when its value changes. Keep that
  // snapshot across focus changes; resetting preedit must not erase it.
  [[self inputContext] discardMarkedText];
}
- (void)copyPreedit:(char**)text cursor:(guint*)cursor {
  if (text) *text = g_strdup(mMarked ? [mMarked UTF8String] : "");
  if (cursor) *cursor = MIN(mMarkedSelection.location, [mMarked length]);
}
- (void)setSurrounding:(NSString*)text selection:(NSRange)selection {
  [text retain]; [mSurrounding release]; mSurrounding = text;
  mSelection = selection;
}
- (void)setCursor:(NSRect)rect {
  mCursor = rect;
  [[self inputContext] invalidateCharacterCoordinates];
}
- (BOOL)hasMarkedText { return [mMarked length] != 0; }
- (NSRange)markedRange {
  return [self hasMarkedText] ? NSMakeRange(mMarkedStart, [mMarked length]) : NSMakeRange(NSNotFound, 0);
}
- (NSRange)selectedRange {
  if ([self hasMarkedText]) return NSMakeRange([self markedRange].location + mMarkedSelection.location, mMarkedSelection.length);
  return mSelection;
}
- (NSArray*)validAttributesForMarkedText { return @[]; }
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
  if (!mOwner || !mInput) return;
  // WPE's public composition API replaces the current selection/composition.
  // Arbitrary document-range replacement is not represented by that API.
  if (replacement.location != NSNotFound && !NSEqualRanges(replacement, [self markedRange]) && !NSEqualRanges(replacement, mSelection)) return;
  NSString* text = [value isKindOfClass:[NSAttributedString class]] ? [value string] : value;
  auto* context = WPE_INPUT_METHOD_CONTEXT(g_object_ref(mInput));
  bool started = ![self hasMarkedText];
  if (started) mMarkedStart = mSelection.location == NSNotFound ? 0 : mSelection.location;
  [text retain]; [mMarked release]; mMarked = text;
  NSUInteger caret = MIN(selection.location, [text length]);
  mMarkedSelection = NSMakeRange(caret, MIN(selection.length, [text length] - caret));
  if (started) g_signal_emit_by_name(context, "preedit-started");
  g_signal_emit_by_name(context, "preedit-changed");
  g_object_unref(context);
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
  if (!mOwner || !mInput) return;
  if (replacement.location != NSNotFound && !NSEqualRanges(replacement, [self markedRange]) && !NSEqualRanges(replacement, mSelection)) return;
  NSString* text = [value isKindOfClass:[NSAttributedString class]] ? [value string] : value;
  auto* context = WPE_INPUT_METHOD_CONTEXT(g_object_ref(mInput));
  bool composed = [self hasMarkedText];
  [mMarked release]; mMarked = nil;
  g_signal_emit_by_name(context, "committed", [text UTF8String]);
  // For an ordinary key WebKit consumes the committed character as the key's
  // text. A spurious preedit-finished would instead mark that key IME-handled.
  if (composed) g_signal_emit_by_name(context, "preedit-finished");
  g_object_unref(context);
}
- (void)unmarkText {
  if (![self hasMarkedText]) return;
  NSString* text = [[mMarked retain] autorelease];
  [self insertText:text replacementRange:NSMakeRange(NSNotFound, 0)];
}
- (void)doCommandBySelector:(SEL)selector { mInputHandled = false; }
- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
  if (actual) *actual = NSMakeRange(NSNotFound, 0);
  if (!mSurrounding || range.location == NSNotFound || range.location > [mSurrounding length]) return nil;
  NSRange available = NSIntersectionRange(range, NSMakeRange(0, [mSurrounding length]));
  if (actual) *actual = available;
  return [[[NSAttributedString alloc] initWithString:[mSurrounding substringWithRange:available]] autorelease];
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  if (actual) *actual = [self selectedRange];
  return [[self window] convertRectToScreen:[self convertRect:mCursor toView:nil]];
}
- (void)setOwner:(WPEView*)owner {
  mOwner = owner;
  if (!owner) {
    mCommand = nullptr; mCommandData = nullptr;
    [self resetInput];
    [mSurrounding release]; mSurrounding = nil;
    mSelection = NSMakeRange(NSNotFound, 0);
  }
}
- (void)setCommand:(void (*)(const char*, void*))callback data:(void*)data {
  mCommand = callback;
  mCommandData = data;
}
- (BOOL)acceptsFirstResponder { return mOwner != nullptr; }
- (BOOL)becomeFirstResponder {
  if (!mOwner) return NO;
  auto* owner = WPE_VIEW(g_object_ref(mOwner));
  WPECocoaImportClipboard(wpe_display_get_primary());
  wpe_view_focus_in(owner);
  g_object_unref(owner);
  return YES;
}
- (BOOL)resignFirstResponder {
  for (auto& pressed : mCommandKeys) pressed = false;
  if (mOwner) {
    auto* owner = WPE_VIEW(g_object_ref(mOwner));
    wpe_view_focus_out(owner);
    g_object_unref(owner);
  }
  return YES;
}
- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  if (!mOwner || size.width < 1 || size.height < 1) return;
  auto* owner = WPE_VIEW(g_object_ref(mOwner));
  if (auto* top = wpe_view_get_toplevel(owner))
    wpe_toplevel_resized(top, size.width, size.height);
  wpe_view_resized(owner, size.width, size.height);
  g_object_unref(owner);
}
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (mTracking) { [self removeTrackingArea:mTracking]; [mTracking release]; }
  mTracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
    options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved |
      NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
    owner:self userInfo:nil];
  [self addTrackingArea:mTracking];
}
- (void)dispatchInput:(WPEEvent*)input {
  if (!input) return;
  if (mOwner) {
    auto* owner = WPE_VIEW(g_object_ref(mOwner));
    wpe_view_event(owner, input);
    wpe_event_unref(input);
    g_object_unref(owner);
  } else wpe_event_unref(input);
}
- (void)pointerButton:(NSEvent*)event down:(BOOL)down {
  if (!mOwner) return;
  // Changing first responder can synchronously close the tab. Keep the native
  // receiver alive while the owning GObject clears mOwner during disposal.
  [[self retain] autorelease];
  if (down) [[self window] makeFirstResponder:self];
  if (!mOwner) return;
  NSPoint point = [self convertPoint:[event locationInWindow] fromView:nil];
  NSUInteger nativeButton = [event buttonNumber];
  // AppKit's mouseEventWithType constructor does not populate buttonNumber
  // for right-button events. The event type itself identifies these buttons.
  if ([event type] == NSEventTypeRightMouseDown || [event type] == NSEventTypeRightMouseUp) nativeButton = 1;
  else if ([event type] == NSEventTypeLeftMouseDown || [event type] == NSEventTypeLeftMouseUp) nativeButton = 0;
  guint button = nativeButton == 1 ? 3 : nativeButton == 2 ? 2 : nativeButton + 1;
  NSUInteger buttons = [NSEvent pressedMouseButtons];
  if (nativeButton < sizeof(NSUInteger) * 8) {
    if (down) buttons |= NSUInteger(1) << nativeButton;
    else buttons &= ~(NSUInteger(1) << nativeButton);
  }
  [self dispatchInput:wpe_event_pointer_button_new(down ? WPE_EVENT_POINTER_DOWN : WPE_EVENT_POINTER_UP,
    mOwner, WPE_INPUT_SOURCE_MOUSE, EventTime(event), EventModifiers(event, buttons),
    button, point.x, point.y, down ? [event clickCount] : 0)];
}
- (void)mouseDown:(NSEvent*)event { [self pointerButton:event down:YES]; }
- (void)mouseUp:(NSEvent*)event { [self pointerButton:event down:NO]; }
- (void)rightMouseDown:(NSEvent*)event { [self pointerButton:event down:YES]; }
- (void)rightMouseUp:(NSEvent*)event { [self pointerButton:event down:NO]; }
- (void)otherMouseDown:(NSEvent*)event { [self pointerButton:event down:YES]; }
- (void)otherMouseUp:(NSEvent*)event { [self pointerButton:event down:NO]; }
- (void)pointerMove:(NSEvent*)event type:(WPEEventType)type {
  if (!mOwner) return;
  NSPoint point = [self convertPoint:[event locationInWindow] fromView:nil];
  NSUInteger buttons = [NSEvent pressedMouseButtons];
  // A queued drag event describes its own button state. The global snapshot
  // may already reflect a later release (or native test injection).
  if ([event type] == NSEventTypeLeftMouseDragged) buttons |= 1;
  else if ([event type] == NSEventTypeRightMouseDragged) buttons |= 2;
  else if ([event type] == NSEventTypeOtherMouseDragged && [event buttonNumber] < sizeof(NSUInteger) * 8)
    buttons |= NSUInteger(1) << [event buttonNumber];
  [self dispatchInput:wpe_event_pointer_move_new(type, mOwner, WPE_INPUT_SOURCE_MOUSE,
    EventTime(event), EventModifiers(event, buttons),
    point.x, point.y, [event deltaX], [event deltaY])];
}
- (void)mouseMoved:(NSEvent*)event { [self pointerMove:event type:WPE_EVENT_POINTER_MOVE]; }
- (void)mouseDragged:(NSEvent*)event { [self mouseMoved:event]; }
- (void)rightMouseDragged:(NSEvent*)event { [self mouseMoved:event]; }
- (void)otherMouseDragged:(NSEvent*)event { [self mouseMoved:event]; }
- (void)mouseEntered:(NSEvent*)event { [self pointerMove:event type:WPE_EVENT_POINTER_ENTER]; }
- (void)mouseExited:(NSEvent*)event { [self pointerMove:event type:WPE_EVENT_POINTER_LEAVE]; }
- (void)keyboard:(NSEvent*)event down:(BOOL)down {
  if (!mOwner) return;
  [self dispatchInput:wpe_event_keyboard_new(down ? WPE_EVENT_KEYBOARD_KEY_DOWN : WPE_EVENT_KEYBOARD_KEY_UP,
    mOwner, WPE_INPUT_SOURCE_KEYBOARD, EventTime(event),
    EventModifiers(event, [NSEvent pressedMouseButtons]), HardwareKeyCode([event keyCode]), KeyValue(event))];
}
- (BOOL)chromeCommand:(NSEvent*)event {
  if (!mOwner || !mCommand || [self isHiddenOrHasHiddenAncestor]) return NO;
  auto modifiers = [event modifierFlags] & NSEventModifierFlagDeviceIndependentFlagsMask;
  const char* command = nullptr;
  NSString* text = [[event charactersIgnoringModifiers] lowercaseString];
  bool shift = modifiers & NSEventModifierFlagShift;
  if ((modifiers & NSEventModifierFlagCommand) &&
      !(modifiers & (NSEventModifierFlagControl | NSEventModifierFlagOption))) {
    if ([text isEqualToString:@"c"] && !shift) command = "Copy";
    else if ([text isEqualToString:@"x"] && !shift) command = "Cut";
    else if ([text isEqualToString:@"v"] && !shift) command = "Paste";
    else if ([text isEqualToString:@"a"] && !shift) command = "SelectAll";
    else if ([text isEqualToString:@"l"] && !shift) command = "location";
    else if ([text isEqualToString:@"t"] && !shift) command = "new-tab";
    else if ([text isEqualToString:@"w"] && !shift) command = "close-tab";
    else if ([text isEqualToString:@"q"] && !shift) command = "quit";
    else if ([text isEqualToString:@"f"] && !shift) command = "find";
    else if ([text isEqualToString:@"r"] && !shift) command = "reload";
    else if ([text isEqualToString:@"="] || [text isEqualToString:@"+"]) command = "zoom-in";
    else if ([text isEqualToString:@"-"] && !shift) command = "zoom-out";
    else if ([text isEqualToString:@"0"] && !shift) command = "zoom-reset";
    else if ([text isEqualToString:@"["] && !shift) command = "back";
    else if ([text isEqualToString:@"]"] && !shift) command = "forward";
  } else if ((modifiers & NSEventModifierFlagControl) &&
             !(modifiers & (NSEventModifierFlagCommand | NSEventModifierFlagOption)) &&
             [event keyCode] == 48) command = shift ? "previous-tab" : "next-tab";
  if (!command) return NO;
  // XUL may synchronously close the tab/view from this callback. Hold only
  // the native receiver and do not touch the callback owner after dispatch.
  [[self retain] autorelease];
  if ([event keyCode] < 128) mCommandKeys[[event keyCode]] = true;
  mCommand(command, mCommandData);
  return YES;
}
- (BOOL)performKeyEquivalent:(NSEvent*)event {
  if ([[self window] firstResponder] != self) return NO;
  return [self chromeCommand:event];
}
- (void)keyDown:(NSEvent*)event {
  [[self retain] autorelease];
  if (![self chromeCommand:event]) {
    mKeyEvent = event;
    [self keyboard:event down:YES];
    mKeyEvent = nil;
  }
}
- (void)keyUp:(NSEvent*)event {
  if ([event keyCode] < 128 && mCommandKeys[[event keyCode]]) {
    mCommandKeys[[event keyCode]] = false;
    return;
  }
  [self keyboard:event down:NO];
}
- (void)flagsChanged:(NSEvent*)event {
  NSEventModifierFlags mask = 0;
  switch ([event keyCode]) {
    case 54: mask = NX_DEVICERCMDKEYMASK; break;
    case 55: mask = NX_DEVICELCMDKEYMASK; break;
    case 56: mask = NX_DEVICELSHIFTKEYMASK; break;
    case 60: mask = NX_DEVICERSHIFTKEYMASK; break;
    case 58: mask = NX_DEVICELALTKEYMASK; break;
    case 61: mask = NX_DEVICERALTKEYMASK; break;
    case 59: mask = NX_DEVICELCTLKEYMASK; break;
    case 62: mask = NX_DEVICERCTLKEYMASK; break;
    case 57: mask = NSEventModifierFlagCapsLock; break;
    default: return;
  }
  [self keyboard:event down:([event modifierFlags] & mask) != 0];
}
- (void)scrollWheel:(NSEvent*)event {
  if (!mOwner) return;
  NSPoint point = [self convertPoint:[event locationInWindow] fromView:nil];
  bool precise = [event hasPreciseScrollingDeltas];
  bool stop = ([event phase] & (NSEventPhaseEnded | NSEventPhaseCancelled)) ||
    ([event momentumPhase] & (NSEventPhaseEnded | NSEventPhaseCancelled));
  [self dispatchInput:wpe_event_scroll_new(mOwner,
    precise ? WPE_INPUT_SOURCE_TOUCHPAD : WPE_INPUT_SOURCE_MOUSE,
    EventTime(event), EventModifiers(event, [NSEvent pressedMouseButtons]),
    [event scrollingDeltaX], [event scrollingDeltaY], precise, stop, point.x, point.y)];
}
- (BOOL)isFlipped { return YES; }
- (void)setFrameImage:(CGImageRef)image {
  CGImageRetain(image);
  if (mImage) CGImageRelease(mImage);
  mImage = image;
  [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)dirtyRect {
  [[NSColor whiteColor] setFill];
  NSRectFill(dirtyRect);
  if (!mImage) return;
  CGContextRef context = [[NSGraphicsContext currentContext] CGContext];
  CGContextSaveGState(context);
  // WPE's first pixel row is the top row. Quartz images use bottom-up drawing
  // coordinates even in a flipped NSView.
  CGContextTranslateCTM(context, 0, NSHeight([self bounds]));
  CGContextScaleCTM(context, 1, -1);
  CGContextDrawImage(context, NSRectToCGRect([self bounds]), mImage);
  CGContextRestoreGState(context);
}
- (void)dealloc {
  [mMarked release];
  [mSurrounding release];
  if (mTracking) { [self removeTrackingArea:mTracking]; [mTracking release]; }
  if (mImage) CGImageRelease(mImage);
  [super dealloc];
}
@end

struct CocoaWPEView {
  WPEView parent;
  WPEFrameView* native;
  WPEBuffer* pending;
  guint frameSource;
};
struct CocoaWPEViewClass { WPEViewClass parent; };
G_DEFINE_TYPE(CocoaWPEView, cocoa_wpe_view, WPE_TYPE_VIEW)

static gboolean RenderFrame(WPEView* view, WPEBuffer* buffer,
                            const WPERectangle*, guint, GError** error)
{
  g_assert([NSThread isMainThread]);
  auto* self = reinterpret_cast<CocoaWPEView*>(view);
  int width = wpe_buffer_get_width(buffer), height = wpe_buffer_get_height(buffer);
  if (!self->native || self->pending || !WPE_IS_BUFFER_SHM(buffer) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "Cocoa WPE host requires an available bounded SHM frame");
    return FALSE;
  }
  auto* shm = WPE_BUFFER_SHM(buffer);
  guint stride = wpe_buffer_shm_get_stride(shm);
  gsize length = 0;
  auto* bytes = static_cast<const UInt8*>(
    g_bytes_get_data(wpe_buffer_shm_get_data(shm), &length));
  if (wpe_buffer_shm_get_format(shm) != WPE_PIXEL_FORMAT_ARGB8888 ||
      stride < guint(width) * 4 || length / stride < gsize(height) ||
      gsize(stride) * height > 512 * 1024 * 1024) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "Invalid Cocoa WPE SHM layout");
    return FALSE;
  }
  // Copy before acknowledging: the engine may reuse the SHM buffer afterward.
  CFDataRef copy = CFDataCreate(kCFAllocatorDefault, bytes, gsize(stride) * height);
  CGDataProviderRef provider = copy ? CGDataProviderCreateWithCFData(copy) : nullptr;
  CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGImageRef image = provider && color ? CGImageCreate(width, height, 8, 32, stride,
    color, kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst,
    provider, nullptr, false, kCGRenderingIntentDefault) : nullptr;
  if (color) CGColorSpaceRelease(color);
  if (provider) CGDataProviderRelease(provider);
  if (copy) CFRelease(copy);
  if (!image) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "Unable to allocate Cocoa WPE frame image");
    return FALSE;
  }
  [self->native setFrameImage:image];
  CGImageRelease(image);
  self->pending = WPE_BUFFER(g_object_ref(buffer));
  // Match the software host's frame pacing. Acknowledgement must happen after
  // render_buffer returns so WebKit can commit its backing-store state first.
  self->frameSource = g_timeout_add(16, [](gpointer data) -> gboolean {
    auto* self = static_cast<CocoaWPEView*>(data);
    g_assert([NSThread isMainThread]);
    g_object_ref(self); // Signal consumers may synchronously destroy their owner.
    self->frameSource = 0;
    auto* pending = self->pending;
    self->pending = nullptr;
    wpe_view_buffer_rendered(WPE_VIEW(self), pending);
    wpe_view_buffer_released(WPE_VIEW(self), pending);
    g_object_unref(pending);
    g_object_unref(self);
    return G_SOURCE_REMOVE;
  }, self);
  return TRUE;
}

static void cocoa_wpe_view_init(CocoaWPEView* self)
{
  g_assert([NSThread isMainThread]);
  self->native = [[WPEFrameView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
  [self->native setOwner:WPE_VIEW(self)];
}

static void cocoa_wpe_view_class_init(CocoaWPEViewClass* klass)
{
  WPE_VIEW_CLASS(klass)->render_buffer = RenderFrame;
  G_OBJECT_CLASS(klass)->dispose = [](GObject* object) {
    g_assert([NSThread isMainThread]);
    auto* self = reinterpret_cast<CocoaWPEView*>(object);
    if (self->frameSource) {
      g_source_remove(self->frameSource);
      self->frameSource = 0;
    }
    g_clear_object(&self->pending);
    [self->native setOwner:nullptr];
    if ([[self->native window] firstResponder] == self->native)
      [[self->native window] makeFirstResponder:nil];
    [self->native removeFromSuperview];
    [self->native release];
    self->native = nil;
    G_OBJECT_CLASS(cocoa_wpe_view_parent_class)->dispose(object);
  };
}

struct CocoaWPEToplevel { WPEToplevel parent; };
struct CocoaWPEToplevelClass { WPEToplevelClass parent; };
G_DEFINE_TYPE(CocoaWPEToplevel, cocoa_wpe_toplevel, WPE_TYPE_TOPLEVEL)
static void cocoa_wpe_toplevel_init(CocoaWPEToplevel*) {}
static void cocoa_wpe_toplevel_class_init(CocoaWPEToplevelClass*) {}

// The context retains only the native receiver. WPEInputMethodContext owns a
// weak WPEView reference; the receiver borrows the context and clears its WPE
// owner on view disposal. Neither direction extends a destroyed page's life.
struct CocoaWPEInput { WPEInputMethodContext parent; WPEFrameView* native; };
struct CocoaWPEInputClass { WPEInputMethodContextClass parent; };
G_DEFINE_TYPE(CocoaWPEInput, cocoa_wpe_input, WPE_TYPE_INPUT_METHOD_CONTEXT)
static void cocoa_wpe_input_init(CocoaWPEInput*) {}
static void cocoa_wpe_input_class_init(CocoaWPEInputClass* klass)
{
  auto* input = WPE_INPUT_METHOD_CONTEXT_CLASS(klass);
  input->get_preedit_string = [](WPEInputMethodContext* context, char** text, GList** underlines, guint* cursor) {
    [reinterpret_cast<CocoaWPEInput*>(context)->native copyPreedit:text cursor:cursor];
    if (underlines) *underlines = nullptr; // WebKit supplies the default underline.
  };
  input->filter_key_event = [](WPEInputMethodContext* context, WPEEvent* event) -> gboolean {
    return wpe_event_get_event_type(event) == WPE_EVENT_KEYBOARD_KEY_DOWN &&
      [reinterpret_cast<CocoaWPEInput*>(context)->native filterInput];
  };
  input->set_cursor_area = [](WPEInputMethodContext* context, int x, int y, int width, int height) {
    [reinterpret_cast<CocoaWPEInput*>(context)->native setCursor:NSMakeRect(x, y, width, height)];
  };
  input->set_surrounding = [](WPEInputMethodContext* context, const char* text, guint length, guint cursor, guint selection) {
    if (cursor > length || selection > length) return;
    NSString* whole = [[[NSString alloc] initWithBytes:text length:length encoding:NSUTF8StringEncoding] autorelease];
    NSString* before = [[[NSString alloc] initWithBytes:text length:cursor encoding:NSUTF8StringEncoding] autorelease];
    NSString* selected = [[[NSString alloc] initWithBytes:text length:selection encoding:NSUTF8StringEncoding] autorelease];
    if (!whole || !before || !selected) return;
    NSUInteger a = [before length], b = [selected length];
    [reinterpret_cast<CocoaWPEInput*>(context)->native setSurrounding:whole selection:NSMakeRange(MIN(a, b), MAX(a, b) - MIN(a, b))];
  };
  input->reset = [](WPEInputMethodContext* context) { [reinterpret_cast<CocoaWPEInput*>(context)->native resetInput]; };
  input->focus_out = input->reset;
  G_OBJECT_CLASS(klass)->dispose = [](GObject* object) {
    auto* self = reinterpret_cast<CocoaWPEInput*>(object);
    [self->native setInputMethod:nullptr];
    [self->native resetInput];
    [self->native release]; self->native = nil;
    G_OBJECT_CLASS(cocoa_wpe_input_parent_class)->dispose(object);
  };
}

struct CocoaWPEDisplay {
  WPEDisplay parent;
  void (*created)(WPEView*, void*);
  void* data;
};
struct CocoaWPEDisplayClass { WPEDisplayClass parent; };
G_DEFINE_TYPE(CocoaWPEDisplay, cocoa_wpe_display, WPE_TYPE_DISPLAY)
static void cocoa_wpe_display_init(CocoaWPEDisplay*) {}
static void cocoa_wpe_display_class_init(CocoaWPEDisplayClass* klass)
{
  auto* display = WPE_DISPLAY_CLASS(klass);
  display->create_input_method_context = [](WPEDisplay*, WPEView* view) -> WPEInputMethodContext* {
    auto* input = reinterpret_cast<CocoaWPEInput*>(g_object_new(cocoa_wpe_input_get_type(), "view", view, nullptr));
    input->native = [static_cast<WPEFrameView*>(WPECocoaViewNative(view)) retain];
    [input->native setInputMethod:WPE_INPUT_METHOD_CONTEXT(input)];
    [input->native resetInput];
    return WPE_INPUT_METHOD_CONTEXT(input);
  };
  display->connect = [](WPEDisplay*, GError**) -> gboolean { return TRUE; };
  display->create_view = [](WPEDisplay* display) -> WPEView* {
    auto* view = WPE_VIEW(g_object_new(cocoa_wpe_view_get_type(), "display", display, nullptr));
    auto* self = reinterpret_cast<CocoaWPEDisplay*>(display);
    if (self->created) self->created(view, self->data);
    return view;
  };
  display->create_toplevel = [](WPEDisplay* display, guint) -> WPEToplevel* {
    return WPE_TOPLEVEL(g_object_new(cocoa_wpe_toplevel_get_type(), "display", display, nullptr));
  };
}

WPEDisplay* WPECocoaDisplayNew()
{
  g_assert([NSThread isMainThread]);
  return WPE_DISPLAY(g_object_new(cocoa_wpe_display_get_type(), nullptr));
}

NSView* WPECocoaViewNative(WPEView* view)
{
  g_assert([NSThread isMainThread]);
  g_return_val_if_fail(G_TYPE_CHECK_INSTANCE_TYPE(view, cocoa_wpe_view_get_type()), nil);
  return reinterpret_cast<CocoaWPEView*>(view)->native;
}

void WPECocoaDisplaySetViewCreated(WPEDisplay* display, void (*callback)(WPEView*, void*), void* data)
{
  g_assert([NSThread isMainThread]);
  g_return_if_fail(G_TYPE_CHECK_INSTANCE_TYPE(display, cocoa_wpe_display_get_type()));
  auto* self = reinterpret_cast<CocoaWPEDisplay*>(display);
  self->created = callback;
  self->data = data;
}

void WPECocoaViewSetCommand(WPEView* view, void (*callback)(const char*, void*), void* data)
{
  [static_cast<WPEFrameView*>(WPECocoaViewNative(view)) setCommand:callback data:data];
}
