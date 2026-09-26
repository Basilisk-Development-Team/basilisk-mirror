/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPERuntime.h"
#include "nsDirectoryServiceUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIFile.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include <glib.h>
#include <gst/gst.h>

namespace { bool sSandboxedWebRTCTransport = false; }

nsresult WPEInitializeRuntime()
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  static bool initialized = false;
  if (initialized) return NS_OK;
  nsCOMPtr<nsIFile> directory;
  nsresult rv = NS_GetSpecialDirectory(NS_GRE_DIR, getter_AddRefs(directory));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = directory->AppendNative(NS_LITERAL_CSTRING("webkit"));
  NS_ENSURE_SUCCESS(rv, rv);
  nsAutoCString root;
  rv = directory->GetNativePath(root);
  NS_ENSURE_SUCCESS(rv, rv);
  // Fail locally if packaging is incomplete. Never fall back to a compiled-in
  // developer prefix, or an unrelated WebKit selected by the environment.
  for (const char* relative : {"/libexec/WPEWebProcess", "/libexec/WPENetworkProcess",
                               "/injected-bundle/libWPEInjectedBundle.so", "/share/inspector.gresource"}) {
    nsAutoCString path(root);
    path.Append(relative);
    NS_ENSURE_TRUE(g_file_test(path.get(), G_FILE_TEST_IS_REGULAR), NS_ERROR_FILE_NOT_FOUND);
  }
  nsAutoCString helpers(root), bundle(root), resources(root), modules(root);
  helpers.AppendLiteral("/libexec");
  bundle.AppendLiteral("/injected-bundle");
  resources.AppendLiteral("/share");
  modules.AppendLiteral("/lib/modules");
  // These are upstream embedding lookup overrides. WEBKIT_EXEC_PATH requires
  // upstream's DEVELOPER_MODE build option; staging verifies that support.
  g_setenv("WEBKIT_EXEC_PATH", helpers.get(), TRUE);
  g_setenv("WEBKIT_INJECTED_BUNDLE_PATH", bundle.get(), TRUE);
  g_setenv("WEBKIT_INSPECTOR_RESOURCES_PATH", resources.get(), TRUE);
  g_setenv("WPE_PLATFORMS_PATH", modules.get(), TRUE);
  nsAutoCString plugins(root);
  plugins.AppendLiteral("/lib/gstreamer-1.0");
  if (g_file_test(plugins.get(), G_FILE_TEST_IS_DIR)) {
    const char* existing = g_getenv("GST_PLUGIN_PATH_1_0");
    if (existing && *existing) { plugins.Append(':'); plugins.Append(existing); }
    g_setenv("GST_PLUGIN_PATH_1_0", plugins.get(), TRUE);
  }
  nsAutoCString metadata(root); metadata.AppendLiteral("/share/basilisk-build.ini");
  auto* features = g_key_file_new();
  if (g_key_file_load_from_file(features, metadata.get(), G_KEY_FILE_NONE, nullptr)) {
    // The libnice fallback runs ICE in the network-isolated WebProcess. Only
    // upstream's network-process broker can safely provide this capability.
    sSandboxedWebRTCTransport = g_key_file_get_boolean(features, "Build", "ENABLE_WEB_RTC", nullptr) &&
      g_key_file_get_boolean(features, "Build", "USE_GSTREAMER_WEBRTC", nullptr) &&
      g_key_file_get_boolean(features, "Build", "USE_LIBRICE", nullptr) &&
      g_key_file_get_boolean(features, "Build", "ENABLE_BUBBLEWRAP_SANDBOX", nullptr);
  }
  g_key_file_unref(features);
  initialized = true;
  return NS_OK;
}

bool WPEWebRTCPluginsAvailable()
{
  if (!sSandboxedWebRTCTransport) return false;
  // Cache runtime discovery, never rescan plugins for every state notification.
  static const bool available = []() {
    if (!gst_init_check(nullptr, nullptr, nullptr)) return false;
    for (const char* name : {"webrtcbin", "nicesrc", "nicesink", "dtlsenc", "dtlsdec",
                             "srtpenc", "srtpdec", "sctpenc", "sctpdec"}) {
      auto* factory = gst_element_factory_find(name);
      if (!factory) return false;
      gst_object_unref(factory);
    }
    return true;
  }();
  return available;
}
