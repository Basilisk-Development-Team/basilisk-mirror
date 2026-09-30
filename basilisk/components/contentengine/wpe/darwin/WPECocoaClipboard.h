/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPECocoaClipboard_h
#define WPECocoaClipboard_h
#include <wpe/wpe-platform.h>
@class NSPasteboard;
// Backend-private plain-text clipboard bridge. The display owns its state.
// A named pasteboard permits testing without changing the user's clipboard.
void WPECocoaConfigureClipboard(WPEDisplay*, NSPasteboard*);
void WPECocoaImportClipboard(WPEDisplay*);
#endif
