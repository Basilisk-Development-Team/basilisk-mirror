/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEHostPlatform_h
#define WPEHostPlatform_h

struct WPEHost;
struct WPEHostWindow;
struct _WebKitNetworkSession;

// Private WPE host boundary. nativeWidget is UXP's NS_NATIVE_WIDGET value;
// only the platform implementation interprets it. This is not a content API.
WPEHostWindow* wpe_host_window_new(void* nativeWidget);
void wpe_host_window_free(WPEHostWindow*);
// Borrowed session; set_session retains its own reference for the chrome window.
_WebKitNetworkSession* wpe_host_window_session(WPEHostWindow*, const char* key);
void wpe_host_window_set_session(WPEHostWindow*, const char* key, _WebKitNetworkSession*);
bool wpe_host_mount(WPEHost*, WPEHostWindow*, void (*closed)(void*), void* data);
void wpe_host_disconnect(WPEHost*, void* data);
double wpe_host_scale(WPEHost*);
void wpe_host_set_bounds(WPEHost*, WPEHostWindow*, int x, int y, int width, int height);
void wpe_host_set_visible(WPEHost*, bool);
void wpe_host_focus(WPEHost*);
bool wpe_host_has_focus(WPEHost*);
void wpe_host_execute_editing_command(WPEHost*, const char*);
void wpe_host_focus_chrome(WPEHostWindow*);
#endif
