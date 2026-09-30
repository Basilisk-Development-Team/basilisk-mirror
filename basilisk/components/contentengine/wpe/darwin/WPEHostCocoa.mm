/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "../WPEHost.h"
#include "../WPEHostPlatform.h"
#include "WPECocoaSurface.h"
#include "WPECocoaClipboard.h"
#include "WPEGLibRunLoop.h"
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <cmath>

@interface WPEWindowSession : NSObject {
@public
  WebKitNetworkSession* session;
}
@end
@implementation WPEWindowSession
- (void)closed:(NSNotification*)notification { g_clear_object(&session); }
- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  g_clear_object(&session);
  [super dealloc];
}
@end

@interface WPEWindowObserver : NSObject {
@public
  void (*closed)(void*);
  void* data;
}
@end
@implementation WPEWindowObserver
- (void)closed:(NSNotification*)notification {
  // The callback may synchronously release its host and this observer.
  [[self retain] autorelease];
  if (closed) closed(data);
}
- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [super dealloc];
}
@end

struct WPEHostWindow { NSView* parent; };
struct WPECocoaHostState {
  WPEWindowObserver* observer = nil;
  NSView* parent = nil; // Borrowed from WPEHostWindow; destroyed after host.
};
static char sessionAssociation;

WPEHostWindow* wpe_host_window_new(void* native)
{
  g_assert([NSThread isMainThread]);
  NSView* parent = static_cast<NSView*>(native);
  if (!parent || ![parent window]) return nullptr;
  // Network/storage work can remain pending after the last view closes. Keep
  // the GLib integration alive for the application lifetime, not one tab.
  static auto loop = WPEGLibRunLoop::Create(g_main_context_default());
  return new WPEHostWindow { [parent retain] };
}
void wpe_host_window_free(WPEHostWindow* window)
{
  if (!window) return;
  [window->parent release];
  delete window;
}
WebKitNetworkSession* wpe_host_window_session(WPEHostWindow* window, const char* key)
{
  WPEWindowSession* owner = [(NSDictionary*)objc_getAssociatedObject([window->parent window], &sessionAssociation) objectForKey:[NSString stringWithUTF8String:key]];
  return owner ? owner->session : nullptr;
}
void wpe_host_window_set_session(WPEHostWindow* window, const char* key, WebKitNetworkSession* session)
{
  NSWindow* native = [window->parent window];
  auto* owner = [[WPEWindowSession alloc] init];
  owner->session = WEBKIT_NETWORK_SESSION(g_object_ref(session));
  [[NSNotificationCenter defaultCenter] addObserver:owner selector:@selector(closed:)
    name:NSWindowWillCloseNotification object:native];
  auto* sessions = (NSMutableDictionary*)objc_getAssociatedObject(native, &sessionAssociation);
  if (!sessions) {
    sessions = [NSMutableDictionary dictionary];
    objc_setAssociatedObject(native, &sessionAssociation, sessions, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  [sessions setObject:owner forKey:[NSString stringWithUTF8String:key]];
  [owner release];
}

static WPEHost* CreateHost()
{
  g_assert([NSThread isMainThread]);
  auto* host = g_new0(WPEHost, 1);
  host->native = new WPECocoaHostState();
  return host;
}
static void BindView(WPEHost* host)
{
  auto* existing = wpe_view_get_toplevel(host->view);
  host->toplevel = existing ? WPE_TOPLEVEL(g_object_ref(existing)) : wpe_display_create_toplevel(host->display, 1);
  wpe_view_set_toplevel(host->view, host->toplevel);
}
WPEHost* wpe_host_new(WebKitNetworkSession* session)
{
  auto* host = CreateHost();
  {
    host->display = WPECocoaDisplayNew();
    WPECocoaConfigureClipboard(host->display, [NSPasteboard generalPasteboard]);
    if (!wpe_display_connect(host->display, nullptr)) { wpe_host_free(host); return nullptr; }
    wpe_display_set_available_input_devices(host->display,
      static_cast<WPEAvailableInputDevices>(WPE_AVAILABLE_INPUT_DEVICE_MOUSE | WPE_AVAILABLE_INPUT_DEVICE_KEYBOARD));
    auto* ownedSession = session ? WEBKIT_NETWORK_SESSION(g_object_ref(session)) : webkit_network_session_new_ephemeral();
    host->webView = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW,
      "display", host->display, "network-session", ownedSession, nullptr));
    g_object_unref(ownedSession);
  }
  host->view = webkit_web_view_get_wpe_view(host->webView);
  BindView(host);
  g_signal_connect(host->webView, "permission-request", G_CALLBACK(+[](WebKitWebView*, WebKitPermissionRequest* request, gpointer) -> gboolean {
    webkit_permission_request_deny(request);
    return TRUE;
  }), nullptr);
  return host;
}
WPEHost* wpe_host_for_view(WPEView* view)
{
  auto* host = CreateHost();
  host->display = WPE_DISPLAY(g_object_ref(wpe_view_get_display(view)));
  host->view = WPE_VIEW(g_object_ref(view));
  BindView(host);
  return host;
}
bool wpe_host_mount(WPEHost* host, WPEHostWindow* window, void (*closed)(void*), void* data)
{
  g_assert([NSThread isMainThread]);
  if (host->native->parent || ![window->parent window]) return false;
  auto* native = WPECocoaViewNative(host->view);
  [native setHidden:YES];
  [window->parent addSubview:native];
  host->native->parent = window->parent;
  WPECocoaViewSetCommand(host->view, [](const char* command, void* data) {
    auto* host = static_cast<WPEHost*>(data);
    if (!strcmp(command, "Copy") || !strcmp(command, "Cut") ||
        !strcmp(command, "Paste") || !strcmp(command, "SelectAll")) {
      if (host->webView) wpe_host_execute_editing_command(host, command);
    } else if (host->chromeCommand) host->chromeCommand(command, host->chromeData);
  }, host);
  auto* observer = [[WPEWindowObserver alloc] init];
  observer->closed = closed; observer->data = data;
  host->native->observer = observer;
  [[NSNotificationCenter defaultCenter] addObserver:observer selector:@selector(closed:)
    name:NSWindowWillCloseNotification object:[window->parent window]];
  return true;
}
void wpe_host_disconnect(WPEHost* host, void*)
{
  if (!host || !host->native->observer) return;
  host->native->observer->closed = nullptr;
  [[NSNotificationCenter defaultCenter] removeObserver:host->native->observer];
  [host->native->observer release];
  host->native->observer = nil;
}
double wpe_host_scale(WPEHost* host)
{
  return [[host->native->parent window] backingScaleFactor] ?: 1;
}
void wpe_host_resize(WPEHost* host, int width, int height)
{
  [WPECocoaViewNative(host->view) setFrameSize:NSMakeSize(width, height)];
}
void wpe_host_set_bounds(WPEHost* host, WPEHostWindow* window, int x, int y, int width, int height)
{
  g_assert([NSThread isMainThread]);
  double scale = wpe_host_scale(host);
  NSRect frame = NSMakeRect(x / scale, y / scale, std::ceil(width / scale), std::ceil(height / scale));
  if (![window->parent isFlipped]) frame.origin.y = NSHeight([window->parent bounds]) - NSMaxY(frame);
  wpe_toplevel_scale_changed(host->toplevel, scale);
  [WPECocoaViewNative(host->view) setFrame:frame];
}
void wpe_host_set_visible(WPEHost* host, bool visible)
{
  g_assert([NSThread isMainThread]);
  auto* native = WPECocoaViewNative(host->view);
  if (!visible && [[native window] firstResponder] == native) [[native window] makeFirstResponder:host->native->parent];
  [native setHidden:!visible];
  wpe_view_set_visible(host->view, visible);
  if (visible) wpe_view_map(host->view); else wpe_view_unmap(host->view);
}
void wpe_host_focus(WPEHost* host)
{
  WPECocoaImportClipboard(wpe_display_get_primary());
  auto* native = WPECocoaViewNative(host->view);
  if (![native isHiddenOrHasHiddenAncestor]) [[native window] makeFirstResponder:native];
}
bool wpe_host_has_focus(WPEHost* host) { return wpe_view_get_has_focus(host->view); }
void wpe_host_focus_chrome(WPEHostWindow* window) { [[window->parent window] makeFirstResponder:window->parent]; }
void wpe_host_free(WPEHost* host)
{
  g_assert([NSThread isMainThread]);
  if (!host) return;
  wpe_host_disconnect(host, nullptr);
  if (host->view) {
    WPECocoaViewSetCommand(host->view, nullptr, nullptr);
    auto* native = WPECocoaViewNative(host->view);
    if ([[native window] firstResponder] == native) [[native window] makeFirstResponder:host->native->parent];
    [native removeFromSuperview];
    if (host->webView) webkit_web_view_stop_loading(host->webView);
    wpe_view_unmap(host->view);
    wpe_view_set_toplevel(host->view, nullptr);
    if (host->webView) g_object_unref(host->webView); else g_object_unref(host->view);
  }
  g_clear_object(&host->toplevel);
  g_clear_object(&host->display);
  delete host->native;
  g_free(host);
}

void wpe_host_execute_editing_command(WPEHost* host, const char* command)
{
  g_assert([NSThread isMainThread]);
  if (!strcmp(command, "Paste")) WPECocoaImportClipboard(wpe_display_get_primary());
  webkit_web_view_execute_editing_command(host->webView, command);
}

void wpe_host_inspector_action(WPEHost* host, GAction* action)
{
  g_assert([NSThread isMainThread]);
  // In the pinned WPE API both toggle_inspector and the Inspect Element action
  // synchronously createFrontendPage before their asynchronous connection work.
  // Only that operation owns this callback; other views sharing the display
  // (in particular related popup views) must never be mistaken for Inspectors.
  auto* display = WPE_DISPLAY(g_object_ref(host->display));
  struct Dispatch { void (*created)(WPEView*, void*); void* data; } dispatch {
    host->inspectorCreated, host->chromeData
  };
  WPECocoaDisplaySetViewCreated(display, [](WPEView* view, void* data) {
    auto* callback = static_cast<Dispatch*>(data);
    if (callback->created) callback->created(view, callback->data);
  }, &dispatch);
  if (action) g_action_activate(action, nullptr);
  else webkit_web_view_toggle_inspector(host->webView);
  WPECocoaDisplaySetViewCreated(display, nullptr, nullptr);
  g_object_unref(display);
}
