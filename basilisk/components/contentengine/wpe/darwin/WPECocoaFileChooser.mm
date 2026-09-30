/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPECocoaFileChooser.h"
#include "WPECocoaSurface.h"
#include "nsCocoaUtils.h"
#include <wpe/webkit.h>
#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>

static const char* const kChooser = "basilisk-cocoa-file-chooser";
static unsigned sOpenPanels;

// The view owns this controller. The AppKit completion temporarily retains it,
// but never retains or dereferences a content-view/backend C++ pointer.
@interface WPECocoaFileChooser : NSObject {
  NSOpenPanel* mPanel;
  WebKitFileChooserRequest* mRequest;
}
- (void)open:(WebKitFileChooserRequest*)request view:(WebKitWebView*)view;
- (void)cancel;
@end
@implementation WPECocoaFileChooser
- (void)cancel {
  g_assert([NSThread isMainThread]);
  NSOpenPanel* panel = mPanel;
  mPanel = nil;
  auto* request = mRequest;
  mRequest = nullptr;
  if (request) {
    webkit_file_chooser_request_cancel(request);
    g_object_unref(request);
  }
  if (!panel) return;
  [panel.sheetParent endSheet:panel returnCode:NSModalResponseCancel];
  [panel orderOut:nil];
  [panel release];
}
- (void)open:(WebKitFileChooserRequest*)request view:(WebKitWebView*)view {
  g_assert([NSThread isMainThread]);
  NSView* native = WPECocoaViewNative(webkit_web_view_get_wpe_view(view));
  if (mPanel || !native.window || native.hidden) {
    webkit_file_chooser_request_cancel(request);
    return;
  }
  NSOpenPanel* panel = [NSOpenPanel openPanel];
  mPanel = [panel retain];
  mRequest = WEBKIT_FILE_CHOOSER_REQUEST(g_object_ref(request));
  panel.allowsMultipleSelection = webkit_file_chooser_request_get_select_multiple(request);
  panel.canChooseDirectories = NO; // WPE's public request does not expose directory selection.
  panel.canChooseFiles = YES;
  NSMutableArray* types = [NSMutableArray array];
  auto mimeTypes = webkit_file_chooser_request_get_mime_types(request);
  for (auto mime = mimeTypes; mime && *mime; ++mime) {
    NSString* value = [NSString stringWithUTF8String:*mime];
    CFStringRef type = [value isEqualToString:@"image/*"] ? (CFStringRef)CFRetain(kUTTypeImage) :
      [value isEqualToString:@"audio/*"] ? (CFStringRef)CFRetain(kUTTypeAudio) :
      [value isEqualToString:@"video/*"] ? (CFStringRef)CFRetain(kUTTypeMovie) :
      UTTypeCreatePreferredIdentifierForTag(kUTTagClassMIMEType, (CFStringRef)value, nullptr);
    if (type) { [types addObject:(NSString*)type]; CFRelease(type); }
  }
  if (types.count) { panel.allowedFileTypes = types; panel.allowsOtherFileTypes = YES; }
  // Consume existing UXP menu support; do not change its implementation.
  if (!sOpenPanels++) nsCocoaUtils::PrepareForNativeAppModalDialog();
  [panel beginSheetModalForWindow:native.window completionHandler:^(NSModalResponse response) {
    auto* request = mPanel == panel ? mRequest : nullptr;
    if (mPanel == panel) {
      mRequest = nullptr;
      [mPanel release];
      mPanel = nil;
    }
    if (!--sOpenPanels) nsCocoaUtils::CleanUpAfterNativeAppModalDialog();
    if (!request) return; // Canceled owner/navigation; never resolve a later request.
    if (response == NSModalResponseOK) {
      auto* paths = g_ptr_array_new_with_free_func(g_free);
      // The pinned GLib API decodes URL escapes in select_files(), despite
      // accepting local paths. Escape once so a literal "%41" stays literal.
      for (NSURL* url in panel.URLs)
        if (url.isFileURL) g_ptr_array_add(paths, g_uri_escape_string(url.path.UTF8String, "/", TRUE));
      g_ptr_array_add(paths, nullptr);
      webkit_file_chooser_request_select_files(request, (const gchar* const*)paths->pdata);
      g_ptr_array_unref(paths);
    } else webkit_file_chooser_request_cancel(request);
    g_object_unref(request);
  }];
}
- (void)dealloc {
  [self cancel];
  [super dealloc];
}
@end

void WPECocoaFileChooserInstall(WebKitWebView* view)
{
  g_assert([NSThread isMainThread]);
  auto* chooser = [[WPECocoaFileChooser alloc] init];
  g_object_set_data_full(G_OBJECT(view), kChooser, chooser,
    +[](gpointer data) { [(WPECocoaFileChooser*)data release]; });
  g_signal_connect(view, "run-file-chooser", G_CALLBACK(+[](WebKitWebView* view,
    WebKitFileChooserRequest* request, gpointer data) -> gboolean {
      [(WPECocoaFileChooser*)data open:request view:view];
      return TRUE;
    }), chooser);
  g_signal_connect(view, "load-changed", G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent event, gpointer data) {
    if (event == WEBKIT_LOAD_STARTED) [(WPECocoaFileChooser*)data cancel];
  }), chooser);
  g_signal_connect(view, "web-process-terminated", G_CALLBACK(+[](WebKitWebView*, WebKitWebProcessTerminationReason, gpointer data) {
    [(WPECocoaFileChooser*)data cancel];
  }), chooser);
}
void WPECocoaFileChooserCancel(WebKitWebView* view)
{
  if (view) [(WPECocoaFileChooser*)g_object_get_data(G_OBJECT(view), kChooser) cancel];
}
