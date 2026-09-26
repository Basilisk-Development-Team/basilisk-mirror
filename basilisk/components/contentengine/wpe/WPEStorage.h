/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEStorage_h
#define WPEStorage_h
#include "nsError.h"
struct _WebKitNetworkSession;
// Main-thread only. Returns an owned reference, or an error; never falls back
// to WebKit's global default directories if the Basilisk profile is unavailable.
struct ContentViewConfiguration;
nsresult WPEGetProfileSession(const ContentViewConfiguration& config, _WebKitNetworkSession** result);
#endif
