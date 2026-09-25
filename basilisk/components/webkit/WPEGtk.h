/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef BasiliskWPEGtk_h
#define BasiliskWPEGtk_h
#include <gtk/gtk.h>
#include <dlfcn.h>

// UXP deliberately links a GTK shim so GTK2 NPAPI processes remain possible.
// Resolve the host's extra GTK3 entry points only when creating a WPE view in
// the main process; do not add a direct GTK3 dependency to libxul.
struct WPEGtk {
  decltype(&gtk_drawing_area_new) drawingAreaNew;
  decltype(&gtk_widget_get_scale_factor) scaleFactor;
  decltype(&gdk_window_ensure_native) ensureNative;
  decltype(&gdk_event_get_scroll_deltas) scrollDeltas;

  static const WPEGtk& Get() {
    static const WPEGtk api = {
      reinterpret_cast<decltype(drawingAreaNew)>(dlsym(RTLD_DEFAULT, "gtk_drawing_area_new")),
      reinterpret_cast<decltype(scaleFactor)>(dlsym(RTLD_DEFAULT, "gtk_widget_get_scale_factor")),
      reinterpret_cast<decltype(ensureNative)>(dlsym(RTLD_DEFAULT, "gdk_window_ensure_native")),
      reinterpret_cast<decltype(scrollDeltas)>(dlsym(RTLD_DEFAULT, "gdk_event_get_scroll_deltas"))
    };
    return api;
  }
  bool Available() const {
    return drawingAreaNew && scaleFactor && ensureNative && scrollDeltas;
  }
};
#endif
