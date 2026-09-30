/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEStorage.h"
#include "ContentViewConfiguration.h"
#include "WPERuntime.h"
#include "nsIContentStorage.h"
#include "nsIObserver.h"
#include "nsISimpleEnumerator.h"
#include "nsDirectoryServiceUtils.h"
#include "nsAppDirectoryServiceDefs.h"
#include "mozilla/ModuleUtils.h"
#include "mozilla/Preferences.h"
#include "nsIFile.h"
#include "nsCOMPtr.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include <wpe/webkit.h>

namespace {
GHashTable* Sessions()
{
  // Chrome windows and their views own the strong references. Weak caches
  // share storage across windows without retaining a private session forever.
  static GHashTable* sessions = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
    [](gpointer data) { auto* ref = static_cast<GWeakRef*>(data); g_weak_ref_clear(ref); g_free(ref); });
  return sessions;
}
}

nsresult WPEGetProfileSession(const ContentViewConfiguration& config, WebKitNetworkSession** result)
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  *result = nullptr;
  const bool isPrivate = config.privateBrowsing;
  nsAutoCString key;
  nsresult pathResult = config.profileDirectory->GetNativePath(key);
  NS_ENSURE_SUCCESS(pathResult, pathResult);
  key.Append(isPrivate ? "/private/" : "/normal/");
  key.AppendInt(config.userContextId);
  auto* slot = static_cast<GWeakRef*>(g_hash_table_lookup(Sessions(), key.get()));
  if (!slot) {
    slot = g_new0(GWeakRef, 1);
    g_weak_ref_init(slot, nullptr);
    g_hash_table_insert(Sessions(), g_strdup(key.get()), slot);
  }
  auto* session = static_cast<WebKitNetworkSession*>(g_weak_ref_get(slot));
  if (!session && isPrivate) session = webkit_network_session_new_ephemeral();
  if (!session) {
    nsCOMPtr<nsIFile> directory;
    nsresult rv = config.profileDirectory->Clone(getter_AddRefs(directory));
    NS_ENSURE_SUCCESS(rv, rv);
    rv = directory->AppendNative(NS_LITERAL_CSTRING("webkit"));
    NS_ENSURE_SUCCESS(rv, rv);
    if (config.userContextId) {
      nsAutoCString container("container-");
      container.AppendInt(config.userContextId);
      rv = directory->AppendNative(container);
      NS_ENSURE_SUCCESS(rv, rv);
    }
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

namespace {
struct CookieClear {
  explicit CookieClear(nsIObserver* observer) : completion(observer) {}
  ~CookieClear() { g_ptr_array_unref(sessions); }
  nsCOMPtr<nsIObserver> completion;
  GPtrArray* sessions = g_ptr_array_new_with_free_func(g_object_unref);
  guint remaining = 0;
  bool failed = false;

  void Add(WebKitNetworkSession* session) {
    for (guint i = 0; i < sessions->len; ++i) {
      if (g_ptr_array_index(sessions, i) == session) {
        g_object_unref(session);
        return;
      }
    }
    g_ptr_array_add(sessions, session);
  }
};

nsresult AddStoredSession(ContentViewConfiguration& config, nsIFile* directory,
                         CookieClear& clear)
{
  nsCOMPtr<nsIFile> cookies;
  nsresult rv = directory->Clone(getter_AddRefs(cookies));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = cookies->AppendNative(NS_LITERAL_CSTRING("cookies.sqlite"));
  NS_ENSURE_SUCCESS(rv, rv);
  bool exists = false;
  rv = cookies->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!exists) return NS_OK;
  WebKitNetworkSession* session = nullptr;
  rv = WPEGetProfileSession(config, &session);
  NS_ENSURE_SUCCESS(rv, rv);
  clear.Add(session);
  return NS_OK;
}

nsresult CollectCookieSessions(CookieClear& clear)
{
  // Retain live sessions until all async deletions finish, including private
  // sessions. Never unlink an open SQLite database underneath the network process.
  GHashTableIter iter;
  gpointer value;
  g_hash_table_iter_init(&iter, Sessions());
  while (g_hash_table_iter_next(&iter, nullptr, &value)) {
    auto* session = static_cast<WebKitNetworkSession*>(g_weak_ref_get(static_cast<GWeakRef*>(value)));
    if (session) clear.Add(session);
  }
  ContentViewConfiguration config;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(config.profileDirectory));
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIFile> root;
  rv = config.profileDirectory->Clone(getter_AddRefs(root));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = root->AppendNative(NS_LITERAL_CSTRING("webkit"));
  NS_ENSURE_SUCCESS(rv, rv);
  bool exists = false;
  rv = root->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!exists) return NS_OK;
  rv = WPEInitializeRuntime();
  NS_ENSURE_SUCCESS(rv, rv);
  rv = AddStoredSession(config, root, clear);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsISimpleEnumerator> entries;
  rv = root->GetDirectoryEntries(getter_AddRefs(entries));
  NS_ENSURE_SUCCESS(rv, rv);
  bool more;
  while (NS_SUCCEEDED(rv = entries->HasMoreElements(&more)) && more) {
    nsCOMPtr<nsISupports> entry;
    rv = entries->GetNext(getter_AddRefs(entry));
    NS_ENSURE_SUCCESS(rv, rv);
    nsCOMPtr<nsIFile> directory = do_QueryInterface(entry);
    NS_ENSURE_TRUE(directory, NS_ERROR_FAILURE);
    nsAutoCString name;
    rv = directory->GetNativeLeafName(name);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!StringBeginsWith(name, NS_LITERAL_CSTRING("container-"))) continue;
    char* end = nullptr;
    guint64 id = g_ascii_strtoull(name.get() + 10, &end, 10);
    if (!id || id > UINT32_MAX || !end || *end) continue;
    nsAutoCString expected("container-");
    expected.AppendInt(uint32_t(id));
    if (!name.Equals(expected)) continue;
    bool isDirectory = false;
    rv = directory->IsDirectory(&isDirectory);
    NS_ENSURE_SUCCESS(rv, rv);
    if (!isDirectory) continue;
    config.userContextId = uint32_t(id);
    rv = AddStoredSession(config, directory, clear);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  return rv;
}

class WPEContentStorage final : public nsIContentStorage {
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICONTENTSTORAGE
private:
  ~WPEContentStorage() = default;
};
NS_IMPL_ISUPPORTS(WPEContentStorage, nsIContentStorage)

NS_IMETHODIMP WPEContentStorage::ClearCookies(nsIObserver* completion)
{
  NS_ENSURE_TRUE(NS_IsMainThread(), NS_ERROR_NOT_SAME_THREAD);
  NS_ENSURE_ARG_POINTER(completion);
  NS_ENSURE_TRUE(mozilla::Preferences::GetBool("webkit.enabled", true), NS_ERROR_NOT_AVAILABLE);
  auto* clear = new CookieClear(completion);
  nsresult rv = CollectCookieSessions(*clear);
  if (NS_FAILED(rv)) { delete clear; return rv; }
  clear->remaining = clear->sessions->len;
  if (!clear->remaining) {
    completion->Observe(nullptr, "content-storage-cookies-cleared", u"success");
    delete clear;
    return NS_OK;
  }
  for (guint i = 0; i < clear->sessions->len; ++i) {
    auto* session = static_cast<WebKitNetworkSession*>(g_ptr_array_index(clear->sessions, i));
    // WebKit's soup backend cannot clear cookies by creation time. A nonzero
    // timespan silently clears nothing, so cookie sanitization clears all cookies.
    webkit_website_data_manager_clear(webkit_network_session_get_website_data_manager(session),
      WEBKIT_WEBSITE_DATA_COOKIES, 0, nullptr,
      [](GObject* source, GAsyncResult* result, gpointer data) {
        auto* clear = static_cast<CookieClear*>(data);
        GError* error = nullptr;
        if (!webkit_website_data_manager_clear_finish(WEBKIT_WEBSITE_DATA_MANAGER(source), result, &error)) {
          clear->failed = true;
          g_clear_error(&error);
        }
        if (!--clear->remaining) {
          clear->completion->Observe(nullptr, "content-storage-cookies-cleared",
                                     clear->failed ? u"error" : u"success");
          delete clear;
        }
      }, clear);
  }
  return NS_OK;
}

#define WEBKIT_CONTENT_STORAGE_CID \
  {0xe5a02b4b, 0x73f4, 0x4797, {0xb9, 0x4e, 0x0e, 0xb1, 0x32, 0x1e, 0x87, 0xf0}}
NS_GENERIC_FACTORY_CONSTRUCTOR(WPEContentStorage)
NS_DEFINE_NAMED_CID(WEBKIT_CONTENT_STORAGE_CID);
const mozilla::Module::CIDEntry kStorageCIDs[] = {
  { &kWEBKIT_CONTENT_STORAGE_CID, false, nullptr, WPEContentStorageConstructor,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
const mozilla::Module::ContractIDEntry kStorageContracts[] = {
  { "@basilisk-browser.org/content-storage;1?engine=webkit", &kWEBKIT_CONTENT_STORAGE_CID,
    mozilla::Module::MAIN_PROCESS_ONLY },
  { nullptr }
};
const mozilla::Module kStorageModule = {
  mozilla::Module::kVersion, kStorageCIDs, kStorageContracts
};
}
NSMODULE_DEFN(WPEContentStorageModule) = &kStorageModule;
