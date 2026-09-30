/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEHostPlatform.h"
#include "WPEHost.h"
#include "WPEGtk.h"
#include "mozcontainer.h"

struct WPEHostWindow {
  GdkWindow* native;
  MozContainer* container;
};

WPEHostWindow* wpe_host_window_new(void* widget)
{
  auto* native = static_cast<GdkWindow*>(widget);
  if (!native) return nullptr;
  gpointer container = nullptr;
  gdk_window_get_user_data(native, &container);
  // With CSD the container owns the GdkWindow. Otherwise its parent does.
  if (container && GTK_IS_WINDOW(container)) container = gtk_bin_get_child(GTK_BIN(container));
  if (!container || !IS_MOZ_CONTAINER(container)) return nullptr;
  return new WPEHostWindow { GDK_WINDOW(g_object_ref(native)), MOZ_CONTAINER(g_object_ref(container)) };
}
void wpe_host_window_free(WPEHostWindow* window)
{
  if (!window) return;
  g_object_unref(window->container);
  g_object_unref(window->native);
  delete window;
}
WebKitNetworkSession* wpe_host_window_session(WPEHostWindow* window, const char* key)
{
  return static_cast<WebKitNetworkSession*>(g_object_get_data(G_OBJECT(window->container), key));
}
void wpe_host_window_set_session(WPEHostWindow* window, const char* key, WebKitNetworkSession* session)
{
  g_object_set_data_full(G_OBJECT(window->container), key, g_object_ref(session), g_object_unref);
}
bool wpe_host_mount(WPEHost* host, WPEHostWindow* window, void (*closed)(void*), void* data)
{
  gtk_widget_set_parent_window(host->area, window->native);
  moz_container_put(window->container, host->area, 0, 0);
  gtk_widget_realize(host->area);
  if (!WPEGtk::Get().ensureNative(gtk_widget_get_window(host->area))) return false;
  // GTK destroys native children before the XUL unload callback in some paths.
  // A closure with a destroy notifier owns only the callback pair, not the view.
  struct Callback { void (*closed)(void*); void* data; };
  auto* callback = new Callback { closed, data };
  g_signal_connect_data(host->area, "destroy", G_CALLBACK(+[](GtkWidget*, gpointer value) {
    auto* callback = static_cast<Callback*>(value);
    callback->closed(callback->data);
  }), callback, +[](gpointer value, GClosure*) { delete static_cast<Callback*>(value); }, G_CONNECT_DEFAULT);
  g_object_set_data(G_OBJECT(host->area), "basilisk-close-callback", callback);
  return true;
}
void wpe_host_disconnect(WPEHost* host, void*)
{
  auto* callback = g_object_get_data(G_OBJECT(host->area), "basilisk-close-callback");
  g_object_set_data(G_OBJECT(host->area), "basilisk-close-callback", nullptr);
  if (callback) g_signal_handlers_disconnect_by_data(host->area, callback);
}
double wpe_host_scale(WPEHost* host) { return WPEGtk::Get().scaleFactor(host->area); }
void wpe_host_set_bounds(WPEHost* host, WPEHostWindow* window, int x, int y, int width, int height)
{
  int scale = wpe_host_scale(host);
  int nativeWidth = (width + scale - 1) / scale;
  int nativeHeight = (height + scale - 1) / scale;
  moz_container_move(window->container, host->area, x / scale, y / scale, nativeWidth, nativeHeight);
  wpe_toplevel_scale_changed(host->toplevel, scale);
  wpe_host_resize(host, nativeWidth, nativeHeight);
}
void wpe_host_set_visible(WPEHost* host, bool visible)
{
  if (visible) gtk_widget_show(host->area); else gtk_widget_hide(host->area);
}
void wpe_host_focus(WPEHost* host) { gtk_widget_grab_focus(host->area); }
void wpe_host_focus_chrome(WPEHostWindow* window) { gtk_widget_grab_focus(GTK_WIDGET(window->container)); }

bool wpe_host_has_focus(WPEHost* host) { return gtk_widget_has_focus(host->area); }

void wpe_host_execute_editing_command(WPEHost* host, const char* command)
{ webkit_web_view_execute_editing_command(host->webView, command); }
void wpe_host_inspector_action(WPEHost* host, GAction* action)
{
  if (action) g_action_activate(action, nullptr);
  else webkit_web_view_toggle_inspector(host->webView);
}
