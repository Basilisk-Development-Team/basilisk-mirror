/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEStorage.h"
#include "nsDirectoryServiceUtils.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsIFile.h"
#include "nsCOMPtr.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include <wpe/webkit.h>

nsresult WPEGetProfileSession(bool isPrivate, WebKitNetworkSession** result)
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  *result = nullptr;
  // Chrome windows and their views own the strong references. Weak caches
  // share storage across windows without retaining a private session forever.
  static GWeakRef normal;
  static GWeakRef privateSession;
  static bool initialized = false;
  if (!initialized) {
    g_weak_ref_init(&normal, nullptr);
    g_weak_ref_init(&privateSession, nullptr);
    initialized = true;
  }
  GWeakRef* slot = isPrivate ? &privateSession : &normal;
  auto* session = static_cast<WebKitNetworkSession*>(g_weak_ref_get(slot));
  if (!session && isPrivate) session = webkit_network_session_new_ephemeral();
  if (!session) {
    nsCOMPtr<nsIFile> directory;
    nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(directory));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = directory->AppendNative(NS_LITERAL_CSTRING("webkit"));
    NS_ENSURE_SUCCESS(rv, rv);
    bool exists = false;
    rv = directory->Exists(&exists);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!exists) {
      rv = directory->Create(nsIFile::DIRECTORY_TYPE, 0700);
      NS_ENSURE_SUCCESS(rv, rv);
    }
    nsAutoCString root;
    rv = directory->GetNativePath(root);
    NS_ENSURE_SUCCESS(rv, rv);
    nsAutoCString data(root);
    data.AppendLiteral("/data");
    nsAutoCString cache(root);
    cache.AppendLiteral("/cache");
    nsAutoCString cookies(root);
    cookies.AppendLiteral("/cookies.sqlite");
    session = webkit_network_session_new(data.get(), cache.get());
    webkit_cookie_manager_set_persistent_storage(
      webkit_network_session_get_cookie_manager(session), cookies.get(), WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
  }
  g_weak_ref_set(slot, session);
  *result = session;
  return NS_OK;
}
