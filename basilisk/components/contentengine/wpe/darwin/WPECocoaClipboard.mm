/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPECocoaClipboard.h"
#import <AppKit/AppKit.h>

namespace {
const char* const kState = "basilisk-cocoa-clipboard";
struct ClipboardState {
  NSPasteboard* board = nil;
  NSInteger count = -1;
  bool importing = false;
  ~ClipboardState() { [board release]; }
};
}
void WPECocoaImportClipboard(WPEDisplay* display)
{
  g_assert([NSThread isMainThread]);
  if (!display) return;
  auto* clipboard = wpe_display_get_clipboard(display);
  auto* state = static_cast<ClipboardState*>(g_object_get_data(G_OBJECT(clipboard), kState));
  if (!state || state->count == [state->board changeCount]) return;
  NSString* text = [state->board stringForType:NSPasteboardTypeString];
  auto* content = wpe_clipboard_content_new();
  if (text) wpe_clipboard_content_set_text(content, [text UTF8String]);
  state->importing = true;
  wpe_clipboard_set_content(clipboard, content);
  state->importing = false;
  state->count = [state->board changeCount];
  wpe_clipboard_content_unref(content);
}
void WPECocoaConfigureClipboard(WPEDisplay* display, NSPasteboard* board)
{
  g_assert([NSThread isMainThread]);
  auto* clipboard = wpe_display_get_clipboard(display);
  auto* state = static_cast<ClipboardState*>(g_object_get_data(G_OBJECT(clipboard), kState));
  if (!state) {
    state = new ClipboardState();
    g_object_set_data_full(G_OBJECT(clipboard), kState, state,
      +[](gpointer data) { delete static_cast<ClipboardState*>(data); });
    g_signal_connect(clipboard, "notify::change-count", G_CALLBACK(+[](WPEClipboard* clipboard, GParamSpec*, gpointer) {
      auto* state = static_cast<ClipboardState*>(g_object_get_data(G_OBJECT(clipboard), kState));
      if (state->importing) return;
      auto* content = wpe_clipboard_get_content(clipboard);
      const char* text = content ? wpe_clipboard_content_get_text(content) : nullptr;
      // Rich data remains in WPE for an unchanged local clipboard. Export of
      // image-only/other formats is a separate capability, not fake text.
      if (content && !text) return;
      [state->board clearContents];
      if (text) [state->board setString:[NSString stringWithUTF8String:text] forType:NSPasteboardTypeString];
      state->count = [state->board changeCount];
    }), nullptr);
  }
  [board retain];
  [state->board release];
  state->board = board;
  state->count = -1;
}
