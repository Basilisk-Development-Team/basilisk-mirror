/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef WPEHost_h
#define WPEHost_h
#include <gtk/gtk.h>
#include <wpe/webkit.h>
#include <wpe/wpe-platform.h>

// No UXP types or Gecko content objects cross the rendering boundary.
struct WPEHost {
  GtkWidget* area;
  WPEDisplay* display;
  WPEToplevel* toplevel;
  WebKitWebView* webView;
  WPEView* view; // borrowed from webView
};
WPEHost* wpe_host_new();
void wpe_host_free(WPEHost* host);
void wpe_host_resize(WPEHost* host, int width, int height);
#endif
