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
  initialized = true;
  return NS_OK;
}
