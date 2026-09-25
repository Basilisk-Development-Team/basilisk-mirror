/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEHost.h"

struct BasiliskWPEView { WPEView parent; };
struct BasiliskWPEViewClass { WPEViewClass parent; };
G_DEFINE_TYPE(BasiliskWPEView, basilisk_wpe_view, WPE_TYPE_VIEW)
static void basilisk_wpe_view_init(BasiliskWPEView*) {}
static void basilisk_wpe_view_class_init(BasiliskWPEViewClass*) {}

struct BasiliskWPEToplevel { WPEToplevel parent; };
struct BasiliskWPEToplevelClass { WPEToplevelClass parent; };
G_DEFINE_TYPE(BasiliskWPEToplevel, basilisk_wpe_toplevel, WPE_TYPE_TOPLEVEL)
static void basilisk_wpe_toplevel_init(BasiliskWPEToplevel*) {}
static void basilisk_wpe_toplevel_class_init(BasiliskWPEToplevelClass*) {}

struct BasiliskWPEDisplay { WPEDisplay parent; };
struct BasiliskWPEDisplayClass { WPEDisplayClass parent; };
G_DEFINE_TYPE(BasiliskWPEDisplay, basilisk_wpe_display, WPE_TYPE_DISPLAY)
static void basilisk_wpe_display_init(BasiliskWPEDisplay*) {}
static void basilisk_wpe_display_class_init(BasiliskWPEDisplayClass* klass)
{
  auto* display = WPE_DISPLAY_CLASS(klass);
  display->connect = [](WPEDisplay*, GError**) -> gboolean { return TRUE; };
  display->create_view = [](WPEDisplay* display) -> WPEView* {
    return WPE_VIEW(g_object_new(basilisk_wpe_view_get_type(),
                                "display", display, nullptr));
  };
  display->create_toplevel = [](WPEDisplay* display, guint) -> WPEToplevel* {
    return WPE_TOPLEVEL(g_object_new(basilisk_wpe_toplevel_get_type(),
                                    "display", display, nullptr));
  };
}

WPEHost* wpe_host_new()
{
  auto* host = g_new0(WPEHost, 1);
  host->area = gtk_drawing_area_new();
  g_object_ref_sink(host->area);
  host->display = WPE_DISPLAY(g_object_new(basilisk_wpe_display_get_type(), nullptr));
  if (!wpe_display_connect(host->display, nullptr)) {
    wpe_host_free(host);
    return nullptr;
  }
  // Keep the experiment's cookies/storage separate and ephemeral.
  auto* session = webkit_network_session_new_ephemeral();
  host->webView = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW,
    "display", host->display, "network-session", session, nullptr));
  g_object_unref(session);
  host->view = webkit_web_view_get_wpe_view(host->webView);
  host->toplevel = wpe_display_create_toplevel(host->display, 1);
  wpe_view_set_toplevel(host->view, host->toplevel);
  g_signal_connect(host->area, "map", G_CALLBACK(+[](GtkWidget*, gpointer data) {
    wpe_view_map(static_cast<WPEHost*>(data)->view);
  }), host);
  g_signal_connect(host->area, "unmap", G_CALLBACK(+[](GtkWidget*, gpointer data) {
    wpe_view_unmap(static_cast<WPEHost*>(data)->view);
  }), host);
  // Browser policy UI has not been implemented. Never auto-approve capture.
  g_signal_connect(host->webView, "permission-request",
    G_CALLBACK(+[](WebKitWebView*, WebKitPermissionRequest* request, gpointer) -> gboolean {
      webkit_permission_request_deny(request);
      return TRUE;
    }), host);
  return host;
}

void wpe_host_resize(WPEHost* host, int width, int height)
{
  wpe_toplevel_resized(host->toplevel, width, height);
  wpe_view_resized(host->view, width, height);
}

void wpe_host_free(WPEHost* host)
{
  if (!host) return;
  if (host->area) {
    g_signal_handlers_disconnect_by_data(host->area, host);
    gtk_widget_destroy(host->area);
  }
  if (host->webView) {
    g_signal_handlers_disconnect_by_data(host->webView, host);
    webkit_web_view_stop_loading(host->webView);
    wpe_view_unmap(host->view);
    wpe_view_set_toplevel(host->view, nullptr);
    g_object_unref(host->webView);
  }
  g_clear_object(&host->toplevel);
  g_clear_object(&host->display);
  g_clear_object(&host->area);
  g_free(host);
}
