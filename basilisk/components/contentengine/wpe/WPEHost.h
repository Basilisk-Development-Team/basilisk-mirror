/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEHost_h
#define WPEHost_h
#ifndef __APPLE__
#include <gtk/gtk.h>
#endif
struct WPECocoaHostState;
#include <wpe/webkit.h>
#include <wpe/wpe-platform.h>

// No UXP types or Gecko content objects cross the rendering boundary.
struct WPEHost {
#ifdef __APPLE__
  WPECocoaHostState* native;
#else
  GtkWidget* area;
#endif
  WPEDisplay* display;
  WPEToplevel* toplevel;
  WebKitWebView* webView;
  WPEView* view; // borrowed from webView
  void (*chromeCommand)(const char*, void*);
  void* chromeData;
  void (*inspectorCreated)(WPEView*, void*);
  void (*permissionDenied)(const char*, void*);
};
WPEHost* wpe_host_new(WebKitNetworkSession* session = nullptr);
WPEHost* wpe_host_for_view(WPEView* view);
void wpe_host_inspector_action(WPEHost*, GAction* = nullptr);
void wpe_host_free(WPEHost* host);
void wpe_host_resize(WPEHost* host, int width, int height);
#endif
