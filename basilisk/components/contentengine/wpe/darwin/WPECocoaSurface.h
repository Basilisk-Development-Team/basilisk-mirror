/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPECocoaSurface_h
#define WPECocoaSurface_h

#include <wpe/wpe-platform.h>
@class NSView;

// Backend-private, main-thread-only SHM presentation. The caller owns the
// returned display and must keep it alive while its views exist. WPEView owns
// its NSView; the native view is borrowed and detached when WPEView is disposed.
// Pointer/scroll, keyboard, composition, focus and resize are translated locally.
// Composition uses WPE's public input-method context and cached editor state.
// Chrome commands use the existing
// backend-private callback and never expose native objects above the shim.
WPEDisplay* WPECocoaDisplayNew();
NSView* WPECocoaViewNative(WPEView*);
void WPECocoaViewSetCommand(WPEView*, void (*callback)(const char*, void*), void*);
void WPECocoaDisplaySetViewCreated(WPEDisplay*, void (*callback)(WPEView*, void*), void*);

#endif
