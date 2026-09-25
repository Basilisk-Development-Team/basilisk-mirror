/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEHost.h"
#include <cstring>

struct BasiliskWPEView {
  WPEView parent;
  GtkWidget* area; // borrowed, cleared before destruction
  cairo_surface_t* surface;
  WPEBuffer* pending;
  guint frameSource;
};
struct BasiliskWPEViewClass { WPEViewClass parent; };
G_DEFINE_TYPE(BasiliskWPEView, basilisk_wpe_view, WPE_TYPE_VIEW)
static void basilisk_wpe_view_init(BasiliskWPEView*) {}
static gboolean RenderBuffer(WPEView* view, WPEBuffer* buffer,
                             const WPERectangle*, guint, GError** error)
{
  auto* self = reinterpret_cast<BasiliskWPEView*>(view);
  int width = wpe_buffer_get_width(buffer), height = wpe_buffer_get_height(buffer);
  if (!WPE_IS_BUFFER_SHM(buffer) || width <= 0 || height <= 0 ||
      width > 16384 || height > 16384 || self->pending) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "WPE host requires a bounded SHM frame");
    return FALSE;
  }
  auto* shm = WPE_BUFFER_SHM(buffer);
  gsize length = 0;
  auto* data = static_cast<const unsigned char*>(
    g_bytes_get_data(wpe_buffer_shm_get_data(shm), &length));
  guint stride = wpe_buffer_shm_get_stride(shm);
  if (wpe_buffer_shm_get_format(shm) != WPE_PIXEL_FORMAT_ARGB8888 ||
      stride < guint(width) * 4 || length / stride < gsize(height)) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "Invalid WPE SHM frame layout");
    return FALSE;
  }
  if (!self->surface || cairo_image_surface_get_width(self->surface) != width ||
      cairo_image_surface_get_height(self->surface) != height) {
    if (self->surface) cairo_surface_destroy(self->surface);
    self->surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
  }
  if (cairo_surface_status(self->surface) != CAIRO_STATUS_SUCCESS) {
    g_set_error_literal(error, WPE_VIEW_ERROR, WPE_VIEW_ERROR_RENDER_FAILED,
                        "Unable to allocate WPE presentation surface");
    return FALSE;
  }
  cairo_surface_flush(self->surface);
  auto* dest = cairo_image_surface_get_data(self->surface);
  int destStride = cairo_image_surface_get_stride(self->surface);
  for (int y = 0; y < height; ++y)
    std::memcpy(dest + gsize(y) * destStride, data + gsize(y) * stride, width * 4);
  cairo_surface_mark_dirty(self->surface);
  if (self->area) gtk_widget_queue_draw(self->area);
  self->pending = WPE_BUFFER(g_object_ref(buffer));
  // Acknowledge asynchronously: the backing store commits after this returns.
  // Throttle software presentation, including when the host is occluded.
  self->frameSource = g_timeout_add(16, [](gpointer data) -> gboolean {
    auto* self = static_cast<BasiliskWPEView*>(data);
    self->frameSource = 0;
    auto* buffer = self->pending;
    self->pending = nullptr;
    wpe_view_buffer_rendered(WPE_VIEW(self), buffer);
    wpe_view_buffer_released(WPE_VIEW(self), buffer);
    g_object_unref(buffer);
    return G_SOURCE_REMOVE;
  }, self);
  return TRUE;
}
static void basilisk_wpe_view_class_init(BasiliskWPEViewClass* klass)
{
  WPE_VIEW_CLASS(klass)->render_buffer = RenderBuffer;
  G_OBJECT_CLASS(klass)->dispose = [](GObject* object) {
    auto* self = reinterpret_cast<BasiliskWPEView*>(object);
    if (self->frameSource) { g_source_remove(self->frameSource); self->frameSource = 0; }
    g_clear_object(&self->pending);
    if (self->surface) { cairo_surface_destroy(self->surface); self->surface = nullptr; }
    G_OBJECT_CLASS(basilisk_wpe_view_parent_class)->dispose(object);
  };
}

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

static WPEModifiers Modifiers(guint state)
{
  unsigned result = 0;
  if (state & GDK_SHIFT_MASK) result |= WPE_MODIFIER_KEYBOARD_SHIFT;
  if (state & GDK_CONTROL_MASK) result |= WPE_MODIFIER_KEYBOARD_CONTROL;
  if (state & GDK_MOD1_MASK) result |= WPE_MODIFIER_KEYBOARD_ALT;
  if (state & (GDK_META_MASK | GDK_SUPER_MASK)) result |= WPE_MODIFIER_KEYBOARD_META;
  if (state & GDK_LOCK_MASK) result |= WPE_MODIFIER_KEYBOARD_CAPS_LOCK;
  if (state & GDK_BUTTON1_MASK) result |= WPE_MODIFIER_POINTER_BUTTON1;
  if (state & GDK_BUTTON2_MASK) result |= WPE_MODIFIER_POINTER_BUTTON2;
  if (state & GDK_BUTTON3_MASK) result |= WPE_MODIFIER_POINTER_BUTTON3;
  return static_cast<WPEModifiers>(result);
}

static gboolean Input(GtkWidget* area, GdkEvent* event, gpointer data)
{
  auto* host = static_cast<WPEHost*>(data);
  WPEEvent* input = nullptr;
  switch (event->type) {
    case GDK_BUTTON_PRESS:
    case GDK_BUTTON_RELEASE: {
      auto& e = event->button;
      if (e.type == GDK_BUTTON_PRESS) gtk_widget_grab_focus(area);
      guint count = e.type == GDK_BUTTON_PRESS ?
        wpe_view_compute_press_count(host->view, e.x, e.y, e.button, e.time) : 0;
      input = wpe_event_pointer_button_new(e.type == GDK_BUTTON_PRESS ?
        WPE_EVENT_POINTER_DOWN : WPE_EVENT_POINTER_UP, host->view,
        WPE_INPUT_SOURCE_MOUSE, e.time, Modifiers(e.state), e.button, e.x, e.y, count);
      break;
    }
    // WPE computes click counts; do not dispatch GTK's synthetic double click again.
    case GDK_2BUTTON_PRESS:
    case GDK_3BUTTON_PRESS:
      return TRUE;
    case GDK_MOTION_NOTIFY: {
      auto& e = event->motion;
      input = wpe_event_pointer_move_new(WPE_EVENT_POINTER_MOVE, host->view,
        WPE_INPUT_SOURCE_MOUSE, e.time, Modifiers(e.state), e.x, e.y, 0, 0);
      break;
    }
    case GDK_ENTER_NOTIFY:
    case GDK_LEAVE_NOTIFY: {
      auto& e = event->crossing;
      input = wpe_event_pointer_move_new(e.type == GDK_ENTER_NOTIFY ?
        WPE_EVENT_POINTER_ENTER : WPE_EVENT_POINTER_LEAVE, host->view,
        WPE_INPUT_SOURCE_MOUSE, e.time, Modifiers(e.state), e.x, e.y, 0, 0);
      break;
    }
    case GDK_SCROLL: {
      auto& e = event->scroll;
      double dx = 0, dy = 0;
      bool precise = gdk_event_get_scroll_deltas(event, &dx, &dy);
      if (!precise) {
        if (e.direction == GDK_SCROLL_UP) dy = -1;
        if (e.direction == GDK_SCROLL_DOWN) dy = 1;
        if (e.direction == GDK_SCROLL_LEFT) dx = -1;
        if (e.direction == GDK_SCROLL_RIGHT) dx = 1;
      }
      input = wpe_event_scroll_new(host->view, WPE_INPUT_SOURCE_MOUSE, e.time,
        Modifiers(e.state), -dx, -dy, precise, precise && dx == 0 && dy == 0, e.x, e.y);
      break;
    }
    case GDK_KEY_PRESS:
    case GDK_KEY_RELEASE: {
      auto& e = event->key;
      input = wpe_event_keyboard_new(e.type == GDK_KEY_PRESS ?
        WPE_EVENT_KEYBOARD_KEY_DOWN : WPE_EVENT_KEYBOARD_KEY_UP, host->view,
        WPE_INPUT_SOURCE_KEYBOARD, e.time, Modifiers(e.state), e.hardware_keycode, e.keyval);
      break;
    }
    case GDK_FOCUS_CHANGE:
      if (event->focus_change.in) {
        wpe_toplevel_state_changed(host->toplevel, WPE_TOPLEVEL_STATE_ACTIVE);
        wpe_view_focus_in(host->view);
      } else {
        wpe_view_focus_out(host->view);
        wpe_toplevel_state_changed(host->toplevel, WPE_TOPLEVEL_STATE_NONE);
      }
      return FALSE;
    default:
      return FALSE;
  }
  wpe_view_event(host->view, input);
  wpe_event_unref(input);
  return TRUE;
}

WPEHost* wpe_host_new()
{
  auto* host = g_new0(WPEHost, 1);
  host->area = gtk_drawing_area_new();
  g_object_ref_sink(host->area);
  gtk_widget_set_can_focus(host->area, TRUE);
  gtk_widget_add_events(host->area, GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK |
    GDK_POINTER_MOTION_MASK | GDK_ENTER_NOTIFY_MASK | GDK_LEAVE_NOTIFY_MASK |
    GDK_SCROLL_MASK | GDK_SMOOTH_SCROLL_MASK | GDK_KEY_PRESS_MASK |
    GDK_KEY_RELEASE_MASK | GDK_FOCUS_CHANGE_MASK);
  g_signal_connect(host->area, "event", G_CALLBACK(Input), host);
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
  auto* nativeView = reinterpret_cast<BasiliskWPEView*>(host->view);
  nativeView->area = host->area;
  g_signal_connect(host->area, "draw", G_CALLBACK(+[](GtkWidget*, cairo_t* cr, gpointer data) -> gboolean {
    auto* view = reinterpret_cast<BasiliskWPEView*>(static_cast<WPEHost*>(data)->view);
    if (view->surface) {
      cairo_set_source_surface(cr, view->surface, 0, 0);
      cairo_paint(cr);
    }
    return TRUE;
  }), host);
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
    auto* view = reinterpret_cast<BasiliskWPEView*>(host->view);
    view->area = nullptr;
    if (view->frameSource) { g_source_remove(view->frameSource); view->frameSource = 0; }
    if (view->pending) {
      wpe_view_buffer_rendered(host->view, view->pending);
      wpe_view_buffer_released(host->view, view->pending);
      g_clear_object(&view->pending);
    }
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
