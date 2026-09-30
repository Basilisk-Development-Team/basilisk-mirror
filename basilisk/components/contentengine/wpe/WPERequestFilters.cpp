/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WPEContentView.h"
#include "WPEHost.h"
#include "nsIContentRequestRule.h"
#include "nsHashPropertyBag.h"
#include "nsNetUtil.h"
#include "nsIURI.h"
#include "nsCharSeparatedTokenizer.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/UniquePtr.h"
#include <algorithm>

static constexpr uint32_t kBlocksPerPolicyPart = 131072;
static constexpr uint32_t kConcurrentPolicyCompilations = 1;
static constexpr uint32_t kCachedPolicies = 4;
static const char kStoredPolicyPrefix[] = "basilisk-policy-v1-";
static uint32_t sActivePolicyCompilations = 0;
struct WPEPolicyCompilation {
  RefPtr<WPEContentView> owner;
  nsCString token;
  nsCString identifier;
  nsCString cacheKey;
  bool persistent = false;
  uint64_t generation;
  uint32_t request;
  uint32_t part = 0;
  uint32_t completed = 0;
  uint32_t active = 0;
  uint32_t blocks = 0;
  nsCString error;
  nsTArray<WebKitUserContentFilterStore*> storePool;
  nsTArray<WebKitUserContentFilterStore*> stores;
  bool busy[kConcurrentPolicyCompilations] = {};
  GCancellable* cancellation;
  nsTArray<nsCString> rules;
  nsTArray<bool> allows;
  nsTArray<nsCString> storeIds;
  nsTArray<WebKitUserContentFilter*> filters;
  ~WPEPolicyCompilation() {
    for (auto* filter : filters) if (filter) webkit_user_content_filter_unref(filter);
    for (auto* store : stores) g_object_unref(store);
    for (auto* store : storePool) g_object_unref(store);
    g_object_unref(cancellation);
  }
};

struct WPEPolicyPart {
  WPEPolicyCompilation* compilation;
  uint32_t index;
  uint32_t slot;
};

namespace {
bool NoPatternWhitespace(char16_t) { return false; }
struct Policy {
  uint64_t generation = 0;
  bool enabled = true;
  bool persistent = false;
  nsCString cacheKey;
  nsCString pendingKey;
  nsTArray<WebKitUserContentFilter*> filters;
  nsTArray<nsCString> storeIds;
  nsTArray<WebKitUserContentFilterStore*> stores;
  ~Policy() {
    for (auto* filter : filters) webkit_user_content_filter_unref(filter);
    for (auto* store : stores) g_object_unref(store);
  }
};
// Compiled filters are immutable and may be attached to different views.
// Keep a small process-local cache so opening/adopting/switching tabs does not
// rebuild the same full policy. Profile path is part of the content hash. No
// private policies enter this cache. The cache owns filter references, not
// backing files: disk eviction leaves retained filters usable.
struct CachedPolicy {
  nsCString key;
  nsTArray<WebKitUserContentFilter*> filters;
  ~CachedPolicy() {
    for (auto* filter : filters) webkit_user_content_filter_unref(filter);
  }
};
using PolicyCache = nsTArray<mozilla::UniquePtr<CachedPolicy>>;
mozilla::StaticAutoPtr<PolicyCache> sPolicyCache;
CachedPolicy* FindCachedPolicy(const nsCString& key) {
  if (sPolicyCache) for (const auto& entry : *sPolicyCache)
    if (entry->key.Equals(key)) return entry.get();
  return nullptr;
}
void CachePolicy(const nsCString& key, const nsTArray<WebKitUserContentFilter*>& filters) {
  if (!sPolicyCache) {
    sPolicyCache = new PolicyCache();
    mozilla::ClearOnShutdown(&sPolicyCache);
  }
  if (FindCachedPolicy(key)) return;
  if (sPolicyCache->Length() == kCachedPolicies) sPolicyCache->RemoveElementAt(0);
  auto entry = mozilla::MakeUnique<CachedPolicy>();
  entry->key = key;
  for (auto* filter : filters) entry->filters.AppendElement(webkit_user_content_filter_ref(filter));
  sPolicyCache->AppendElement(std::move(entry));
}
void RemoveStored(WebKitUserContentFilterStore* store, const nsCString& id)
{
  if (!id.IsEmpty()) webkit_user_content_filter_store_remove(store, id.get(), nullptr,
    [](GObject* source, GAsyncResult* result, gpointer) {
      GError* error = nullptr;
      webkit_user_content_filter_store_remove_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
      g_clear_error(&error);
    }, nullptr);
}
// Use only public store identifiers for eviction; do not depend on WebKit's
// on-disk filename layout. Keep resident bundles first, then older disk entries
// up to the same bound. Never prune a partially saved bundle.
void PruneStoredPolicies(WebKitUserContentFilterStore* store)
{
  if (sActivePolicyCompilations) return;
  webkit_user_content_filter_store_fetch_identifiers(store, nullptr,
    [](GObject* source, GAsyncResult* result, gpointer) {
      auto* store = WEBKIT_USER_CONTENT_FILTER_STORE(source);
      gchar** ids = webkit_user_content_filter_store_fetch_identifiers_finish(store, result);
      if (!ids) return;
      nsTArray<nsCString> keys, retained;
      if (!sActivePolicyCompilations) {
        for (uint32_t i = 0; ids[i]; ++i) {
          if (!g_str_has_prefix(ids[i], kStoredPolicyPrefix)) continue;
          nsCString key(ids[i] + strlen(kStoredPolicyPrefix));
          int32_t dot = key.FindChar('.');
          if (dot != 64) continue;
          key.Truncate(dot);
          if (!keys.Contains(key)) keys.AppendElement(key);
        }
        for (const auto& key : keys)
          if (FindCachedPolicy(key)) retained.AppendElement(key);
        for (const auto& key : keys)
          if (retained.Length() < kCachedPolicies && !retained.Contains(key)) retained.AppendElement(key);
        for (uint32_t i = 0; ids[i]; ++i) {
          if (!g_str_has_prefix(ids[i], kStoredPolicyPrefix)) continue;
          nsCString key(ids[i] + strlen(kStoredPolicyPrefix));
          int32_t dot = key.FindChar('.');
          if (dot != 64) continue;
          key.Truncate(dot);
          if (!retained.Contains(key)) RemoveStored(store, nsCString(ids[i]));
        }
      }
      g_strfreev(ids);
    }, nullptr);
}
// Pattern syntax is validated by the upstream compiler. JSON encoding must
// not reinterpret backslashes, quotes or control characters as policy fields.
void AppendPattern(nsCString& json, const nsCString& pattern)
{
  json.Append('"');
  for (uint32_t i = 0; i < pattern.Length(); ++i) {
    char c = pattern[i];
    if (c == '\\' || c == '"') json.Append('\\');
    json.Append(c);
  }
  json.Append('"');
}
// Prefix is already ASCII and URI-canonicalized. Escape regex operators, then
// JSON string delimiters, entirely inside the backend's rule translator.
void AppendPrefix(nsCString& json, const nsCString& prefix)
{
  json.AppendLiteral("\"^");
  for (uint32_t i = 0; i < prefix.Length(); ++i) {
    char c = prefix[i];
    if (strchr(".*+?^${}()|[]\\", c)) json.AppendLiteral("\\\\");
    if (c == '\\' || c == '"') json.Append('\\');
    json.Append(c);
  }
  json.Append('"');
}
}

nsresult WPEContentView::EnsureFilterStore()
{
  // The public store API persists compiled policies. Do not open it privately.
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed && !mPrivate, NS_ERROR_NOT_AVAILABLE);
  if (mFilterStore) return NS_OK;
  nsCOMPtr<nsIFile> directory;
  nsresult rv = mProfileDirectory->Clone(getter_AddRefs(directory));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = directory->AppendNative(NS_LITERAL_CSTRING("webkit"));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = directory->AppendNative(NS_LITERAL_CSTRING("content-filters"));
  NS_ENSURE_SUCCESS(rv, rv);
  nsAutoCString path;
  rv = directory->GetNativePath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  mFilterStore = webkit_user_content_filter_store_new(path.get());
  // Upstream serializes compilation by store path. Keep the pool at one:
  // profiling showed concurrent compilers contending on allocator locks. Any
  // future tuning remains bounded and shared by views using this profile.
  for (uint32_t i = 1; i < kConcurrentPolicyCompilations; ++i) {
    nsAutoCString slot(path);
    slot.AppendLiteral("/compiler-"); slot.AppendInt(i);
    mAdditionalFilterStores.AppendElement(webkit_user_content_filter_store_new(slot.get()));
  }
  mFilterCancellation = g_cancellable_new();
  mRequestRules = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
    +[](gpointer item) { delete static_cast<Policy*>(item); });
  return NS_OK;
}

NS_IMETHODIMP WPEContentView::SetRequestRules(uint32_t request, const nsACString& identifier,
                                            uint32_t count, nsIContentRequestRule** rules)
{
  NS_ENSURE_TRUE(!identifier.IsEmpty() && identifier.Length() <= 256 && count && count <= 150000 && rules,
                 NS_ERROR_INVALID_ARG);
  nsAutoCString json;
  nsTArray<nsCString> encodedRules;
  nsTArray<bool> allows;
  uint32_t totalBytes = 0, blocks = 0;
  const char* names[] = {"image", "style-sheet", "script", "font", "media", "document", "fetch", "top-document", "child-document", "websocket", "ping", "other"};
  for (uint32_t i = 0; i < count; ++i) {
    NS_ENSURE_ARG_POINTER(rules[i]);
    nsAutoCString prefix;
    uint32_t types = 0;
    nsresult rv = rules[i]->GetUrlPrefix(prefix);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = rules[i]->GetResourceTypes(&types);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(prefix.Length() <= 8192 && !(types & ~4095u), NS_ERROR_INVALID_ARG);
    nsAutoCString pattern, action;
    bool caseSensitive = true;
    rv = rules[i]->GetUrlPattern(pattern); NS_ENSURE_SUCCESS(rv, rv);
    rv = rules[i]->GetCaseSensitive(&caseSensitive); NS_ENSURE_SUCCESS(rv, rv);
    rv = rules[i]->GetAction(action); NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(action.EqualsLiteral("block") || action.EqualsLiteral("allow"), NS_ERROR_INVALID_ARG);
    NS_ENSURE_TRUE(prefix.IsEmpty() != pattern.IsEmpty() && pattern.Length() <= 8192, NS_ERROR_INVALID_ARG);
    for (uint32_t j = 0; j < pattern.Length(); ++j)
      NS_ENSURE_TRUE(pattern[j] >= 0x20 && pattern[j] <= 0x7e, NS_ERROR_INVALID_ARG);
    nsCOMPtr<nsIURI> uri;
    bool http = false, https = false, ws = false, wss = false;
    nsAutoCString canonical;
    if (!prefix.IsEmpty()) {
      rv = NS_NewURI(getter_AddRefs(uri), prefix); NS_ENSURE_SUCCESS(rv, rv);
      uri->SchemeIs("http", &http); uri->SchemeIs("https", &https);
      uri->SchemeIs("ws", &ws); uri->SchemeIs("wss", &wss);
      NS_ENSURE_TRUE(http || https || ws || wss, NS_ERROR_INVALID_ARG);
      uri->GetAsciiSpec(canonical);
      NS_ENSURE_TRUE(canonical.Equals(prefix), NS_ERROR_INVALID_ARG);
    }
    json.Truncate();
    json.AppendLiteral("{\"trigger\":{\"url-filter\":");
    if (!prefix.IsEmpty()) AppendPrefix(json, prefix);
    else AppendPattern(json, pattern);
    json.Append(caseSensitive ? ",\"url-filter-is-case-sensitive\":true" : ",\"url-filter-is-case-sensitive\":false");
    if (types) {
      json.AppendLiteral(",\"resource-type\":[");
      bool first = true;
      for (uint32_t bit = 0; bit < 12; ++bit) if (types & (1u << bit)) {
        if (!first) json.Append(','); first = false;
        json.Append('"'); json.Append(names[bit]); json.Append('"');
      }
      json.Append(']');
    }
    uint32_t party = 0;
    nsAutoCString top;
    rv = rules[i]->GetParty(&party); NS_ENSURE_SUCCESS(rv, rv);
    rv = rules[i]->GetTopURLPrefix(top); NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(party <= 2 && top.Length() <= 8192, NS_ERROR_INVALID_ARG);
    if (party) json.Append(party == 1 ? ",\"load-type\":[\"first-party\"]" : ",\"load-type\":[\"third-party\"]");
    if (!top.IsEmpty()) {
      rv = NS_NewURI(getter_AddRefs(uri), top); NS_ENSURE_SUCCESS(rv, rv);
      uri->SchemeIs("http", &http); uri->SchemeIs("https", &https);
      NS_ENSURE_TRUE(http || https, NS_ERROR_INVALID_ARG);
      uri->GetAsciiSpec(canonical); NS_ENSURE_TRUE(canonical.Equals(top), NS_ERROR_INVALID_ARG);
      json.AppendLiteral(",\"top-url-filter-is-case-sensitive\":true,\"if-top-url\":[");
      AppendPrefix(json, top); json.Append(']');
    }
    nsAutoCString document;
    bool excludeDocument = false;
    rv = rules[i]->GetDocumentURLPattern(document); NS_ENSURE_SUCCESS(rv, rv);
    rv = rules[i]->GetExcludeDocumentURL(&excludeDocument); NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(document.Length() <= 1024 * 1024 && (document.IsEmpty() || top.IsEmpty()) &&
                   (!excludeDocument || !document.IsEmpty()), NS_ERROR_INVALID_ARG);
    if (!document.IsEmpty()) {
      NS_ENSURE_TRUE(document.First() != '\n' && document.Last() != '\n' &&
                     document.Find("\n\n") == kNotFound, NS_ERROR_INVALID_ARG);
      json.AppendLiteral(",\"frame-url-filter-is-case-sensitive\":false");
      json.Append(excludeDocument ? ",\"unless-frame-url\":[" : ",\"if-frame-url\":[");
      nsCCharSeparatedTokenizerTemplate<NoPatternWhitespace> patterns(document, '\n');
      uint32_t count = 0;
      while (patterns.hasMoreTokens()) {
        nsAutoCString pattern(patterns.nextToken());
        NS_ENSURE_TRUE(++count <= 16384 && !pattern.IsEmpty() && pattern.Length() <= 8192, NS_ERROR_INVALID_ARG);
        for (uint32_t j = 0; j < pattern.Length(); ++j)
          NS_ENSURE_TRUE(pattern[j] >= 0x20 && pattern[j] <= 0x7e, NS_ERROR_INVALID_ARG);
        if (count > 1) json.Append(',');
        AppendPattern(json, pattern);
      }
      json.Append(']');
    }
    // Upstream ignore-previous-rules is scoped to this compiled list. Never
    // merge independently owned policy tokens into one list.
    json.Append(action.EqualsLiteral("allow") ?
      "},\"action\":{\"type\":\"ignore-previous-rules\"}}" :
      "},\"action\":{\"type\":\"block\"}}");
    NS_ENSURE_TRUE(json.Length() <= 64 * 1024 * 1024 - totalBytes, NS_ERROR_INVALID_ARG);
    totalBytes += json.Length();
    encodedRules.AppendElement(json);
    allows.AppendElement(action.EqualsLiteral("allow"));
    if (!allows.LastElement()) ++blocks;
  }
  nsresult rv = EnsureFilterStore();
  NS_ENSURE_SUCCESS(rv, rv);
  nsCString token(identifier);
  auto* policy = static_cast<Policy*>(g_hash_table_lookup(mRequestRules, token.get()));
  if (!policy) { policy = new Policy(); g_hash_table_insert(mRequestRules, g_strdup(token.get()), policy); }
  policy->generation = ++mFilterGeneration;
  policy->pendingKey.Truncate();
  nsAutoCString profilePath;
  rv = mProfileDirectory->GetNativePath(profilePath);
  NS_ENSURE_SUCCESS(rv, rv);
  GChecksum* checksum = g_checksum_new(G_CHECKSUM_SHA256);
  // Changing the translation/partition format or the WebKit build must not
  // reuse bytecode compiled with different semantics.
  nsAutoCString format(kStoredPolicyPrefix);
  format.AppendInt(webkit_get_major_version()); format.Append('.');
  format.AppendInt(webkit_get_minor_version()); format.Append('.');
  format.AppendInt(webkit_get_micro_version()); format.Append('/');
  format.AppendInt(kBlocksPerPolicyPart); format.Append('/');
  g_checksum_update(checksum, reinterpret_cast<const guchar*>(format.get()), format.Length());
  g_checksum_update(checksum, reinterpret_cast<const guchar*>(profilePath.get()), profilePath.Length());
  const guchar separator = 0;
  g_checksum_update(checksum, &separator, 1);
  for (const auto& rule : encodedRules)
    g_checksum_update(checksum, reinterpret_cast<const guchar*>(rule.get()), rule.Length());
  nsCString cacheKey(g_checksum_get_string(checksum));
  g_checksum_free(checksum);
  bool shareable = true;
  GHashTableIter iter; gpointer key, value;
  g_hash_table_iter_init(&iter, mRequestRules);
  while (g_hash_table_iter_next(&iter, &key, &value)) {
    auto* other = static_cast<Policy*>(value);
    // A physical list identifier can only occur once in a content manager.
    // Independent owners with identical rules still need separate lists.
    if (other != policy && (other->cacheKey.Equals(cacheKey) || other->pendingKey.Equals(cacheKey))) shareable = false;
  }
  auto* cached = shareable ? FindCachedPolicy(cacheKey) : nullptr;
  if (policy->cacheKey.Equals(cacheKey) && !policy->filters.IsEmpty()) {
    // The same token is already installed (possibly disabled). In particular,
    // do not add then remove the very same physical list on a memory-cache hit.
    RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
    info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), request);
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), NS_LITERAL_CSTRING("null"));
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), EmptyCString());
    Notify("content-view-policy-result", static_cast<nsIWritablePropertyBag2*>(info));
    return NS_OK;
  }
  if (cached) {
    auto* manager = webkit_web_view_get_user_content_manager(mHost->webView);
    if (policy->enabled) {
      for (auto* filter : cached->filters) webkit_user_content_manager_add_filter(manager, filter);
      for (auto* filter : policy->filters) webkit_user_content_manager_remove_filter(manager, filter);
    }
    for (auto* filter : policy->filters) webkit_user_content_filter_unref(filter);
    policy->filters.Clear();
    if (!policy->persistent) for (uint32_t i = 0; i < policy->storeIds.Length(); ++i) RemoveStored(policy->stores[i], policy->storeIds[i]);
    policy->storeIds.Clear();
    for (auto* store : policy->stores) g_object_unref(store);
    policy->stores.Clear();
    policy->cacheKey = cacheKey;
    policy->persistent = false;
    for (auto* filter : cached->filters) policy->filters.AppendElement(webkit_user_content_filter_ref(filter));
    RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
    info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), request);
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), NS_LITERAL_CSTRING("null"));
    info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), EmptyCString());
    Notify("content-view-policy-result", static_cast<nsIWritablePropertyBag2*>(info));
    return NS_OK;
  }
  policy->pendingKey = cacheKey;
  char* unique = g_uuid_string_random();
  auto* compilation = new WPEPolicyCompilation;
  compilation->owner = this;
  compilation->token = token;
  compilation->persistent = shareable;
  if (shareable) {
    compilation->identifier.Assign(kStoredPolicyPrefix);
    compilation->identifier.Append(cacheKey);
  } else compilation->identifier = unique;
  compilation->cacheKey = cacheKey;
  compilation->generation = policy->generation;
  compilation->request = request;
  compilation->blocks = blocks;
  compilation->storePool.AppendElement(WEBKIT_USER_CONTENT_FILTER_STORE(g_object_ref(mFilterStore)));
  for (auto* store : mAdditionalFilterStores)
    compilation->storePool.AppendElement(WEBKIT_USER_CONTENT_FILTER_STORE(g_object_ref(store)));
  compilation->cancellation = G_CANCELLABLE(g_object_ref(mFilterCancellation));
  compilation->rules.SwapElements(encodedRules);
  compilation->allows.SwapElements(allows);
  g_free(unique);
  ++sActivePolicyCompilations;
  CompileNextPolicy(compilation);
  return NS_OK;
}

void WPEContentView::CompileNextPolicy(WPEPolicyCompilation* compilation)
{
  auto* policy = mRequestRules ? static_cast<Policy*>(g_hash_table_lookup(mRequestRules, compilation->token.get())) : nullptr;
  if (mDestroyed || !policy || policy->generation != compilation->generation) {
    compilation->error.AssignLiteral("Content policy superseded or view closed");
  }
  const uint32_t parts = std::max(1u, (compilation->blocks + kBlocksPerPolicyPart - 1) / kBlocksPerPolicyPart);
  if (!compilation->active && (!compilation->error.IsEmpty() || compilation->part == parts)) {
    FinishPolicyCompilation(compilation, compilation->error.get());
    return;
  }
  // Partition block rules, but retain every subsequent allow in each part.
  // A matching block survives iff no later matching allow cancels it. OR-ing
  // these independent lists therefore preserves the original ordered policy,
  // including a later block overriding an earlier exception. Other owners'
  // policies remain separate. Bound the number of concurrently parsed parts.
  while (compilation->error.IsEmpty() && compilation->part < parts &&
         compilation->active < compilation->storePool.Length()) {
    uint32_t slot = 0;
    while (compilation->busy[slot]) ++slot;
    compilation->busy[slot] = true;
    nsCString storeId(compilation->identifier);
    storeId.Append('.');
    storeId.AppendInt(compilation->part);
    compilation->storeIds.AppendElement(storeId);
    auto* store = compilation->storePool[slot];
    compilation->stores.AppendElement(WEBKIT_USER_CONTENT_FILTER_STORE(g_object_ref(store)));
    compilation->filters.AppendElement(nullptr);
    auto* part = new WPEPolicyPart{compilation, compilation->part++, slot};
    ++compilation->active;
    if (!compilation->persistent) {
      SavePolicyPart(part);
      continue;
    }
    webkit_user_content_filter_store_load(store, storeId.get(), compilation->cancellation,
      [](GObject* source, GAsyncResult* result, gpointer data) {
        auto* part = static_cast<WPEPolicyPart*>(data);
        GError* error = nullptr;
        auto* filter = webkit_user_content_filter_store_load_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
        if (filter || g_cancellable_is_cancelled(part->compilation->cancellation))
          part->compilation->owner->CompletePolicyPart(part, filter, error ? error->message : nullptr, false);
        else
          // Missing, invalid or incompatible bytecode is only a cache miss.
          part->compilation->owner->SavePolicyPart(part);
        g_clear_error(&error);
      }, part);
  }
}

void WPEContentView::SavePolicyPart(WPEPolicyPart* part)
{
  auto* compilation = part->compilation;
  auto* policy = mRequestRules ? static_cast<Policy*>(g_hash_table_lookup(mRequestRules, compilation->token.get())) : nullptr;
  if (mDestroyed || !policy || policy->generation != compilation->generation) {
    CompletePolicyPart(part, nullptr, "Content policy superseded or view closed", false);
    return;
  }
  nsAutoCString json("[");
  uint32_t block = 0;
  bool included = false;
  for (uint32_t i = 0; i < compilation->rules.Length(); ++i) {
    bool keep;
    if (compilation->allows[i]) keep = included || !compilation->blocks;
    else keep = block++ / kBlocksPerPolicyPart == part->index;
    if (!keep) continue;
    if (included) json.Append(',');
    json.Append(compilation->rules[i]);
    included = true;
  }
  json.Append(']');
  GBytes* bytes = g_bytes_new(json.get(), json.Length());
  webkit_user_content_filter_store_save(compilation->stores[part->index],
    compilation->storeIds[part->index].get(), bytes, compilation->cancellation,
    [](GObject* source, GAsyncResult* result, gpointer data) {
      auto* part = static_cast<WPEPolicyPart*>(data);
      GError* error = nullptr;
      auto* filter = webkit_user_content_filter_store_save_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
      part->compilation->owner->CompletePolicyPart(part, filter, error ? error->message : nullptr, true);
      g_clear_error(&error);
    }, part);
  g_bytes_unref(bytes);
}

void WPEContentView::CompletePolicyPart(WPEPolicyPart* part, WebKitUserContentFilter* filter,
                                      const char* error, bool compiled)
{
  auto* compilation = part->compilation;
  compilation->busy[part->slot] = false;
  --compilation->active;
  if (filter) {
    compilation->filters[part->index] = filter;
    ++compilation->completed;
    // Cache loads need no compiler progress event. The policy-result event
    // still completes the request only once the whole bundle is attached.
    if (compiled) {
      RefPtr<nsHashPropertyBag> progress = new nsHashPropertyBag();
      progress->SetPropertyAsUint32(NS_LITERAL_STRING("id"), compilation->request);
      progress->SetPropertyAsDouble(NS_LITERAL_STRING("progress"),
        double(compilation->completed) / std::max(1u, (compilation->blocks + kBlocksPerPolicyPart - 1) / kBlocksPerPolicyPart));
      Notify("content-view-policy-progress", static_cast<nsIWritablePropertyBag2*>(progress));
    }
  } else if (compilation->error.IsEmpty())
    compilation->error.Assign(error ? error : "Policy compiler returned no result");
  CompileNextPolicy(compilation);
  delete part;
}

void WPEContentView::FinishPolicyCompilation(WPEPolicyCompilation* compilation, const char* error)
{
  RefPtr<WPEContentView> owner = this;
  auto* policy = mRequestRules ? static_cast<Policy*>(g_hash_table_lookup(mRequestRules, compilation->token.get())) : nullptr;
  bool current = !mDestroyed && policy && policy->generation == compilation->generation;
  if (current) policy->pendingKey.Truncate();
  if (current && !*error) {
    CachePolicy(compilation->cacheKey, compilation->filters);
    auto* manager = webkit_web_view_get_user_content_manager(mHost->webView);
    if (policy->enabled) {
      for (auto* filter : compilation->filters) webkit_user_content_manager_add_filter(manager, filter);
      for (auto* filter : policy->filters) webkit_user_content_manager_remove_filter(manager, filter);
    }
    policy->filters.SwapElements(compilation->filters);
    policy->storeIds.SwapElements(compilation->storeIds);
    policy->stores.SwapElements(compilation->stores);
    std::swap(policy->persistent, compilation->persistent);
    policy->cacheKey = compilation->cacheKey;
  } else if (current && policy->filters.IsEmpty())
    g_hash_table_remove(mRequestRules, compilation->token.get());
  if (!compilation->persistent || !current || *error)
    for (uint32_t i = 0; i < compilation->storeIds.Length(); ++i)
      RemoveStored(compilation->stores[i], compilation->storeIds[i]);
  RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
  info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), compilation->request);
  info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), NS_LITERAL_CSTRING("null"));
  info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(
    current ? error : "Content policy superseded or view closed"));
  --sActivePolicyCompilations;
  PruneStoredPolicies(compilation->storePool[0]);
  Notify("content-view-policy-result", static_cast<nsIWritablePropertyBag2*>(info));
  delete compilation;
}

NS_IMETHODIMP WPEContentView::RemoveRequestRules(const nsACString& identifier)
{
  if (!mRequestRules) return NS_OK;
  nsCString token(identifier);
  auto* policy = static_cast<Policy*>(g_hash_table_lookup(mRequestRules, token.get()));
  if (!policy) return NS_OK;
  if (policy->enabled && mHost) for (auto* filter : policy->filters)
    webkit_user_content_manager_remove_filter(webkit_web_view_get_user_content_manager(mHost->webView), filter);
  if (!policy->persistent) for (uint32_t i = 0; i < policy->storeIds.Length(); ++i) RemoveStored(policy->stores[i], policy->storeIds[i]);
  g_hash_table_remove(mRequestRules, token.get());
  return NS_OK;
}
NS_IMETHODIMP WPEContentView::SetRequestRulesEnabled(const nsACString& identifier, bool enabled)
{
  NS_ENSURE_TRUE(mHost && mHost->webView && !mDestroyed && mRequestRules, NS_ERROR_NOT_AVAILABLE);
  nsCString token(identifier);
  auto* policy = static_cast<Policy*>(g_hash_table_lookup(mRequestRules, token.get()));
  NS_ENSURE_TRUE(policy && !policy->filters.IsEmpty(), NS_ERROR_NOT_AVAILABLE);
  if (policy->enabled == enabled) return NS_OK;
  auto* manager = webkit_web_view_get_user_content_manager(mHost->webView);
  for (auto* filter : policy->filters) {
    if (enabled) webkit_user_content_manager_add_filter(manager, filter);
    else webkit_user_content_manager_remove_filter(manager, filter);
  }
  policy->enabled = enabled;
  return NS_OK;
}
void WPEContentView::ClearRequestRules()
{
  if (mFilterCancellation) g_cancellable_cancel(mFilterCancellation);
  if (mRequestRules) {
    GHashTableIter iter; gpointer key, value;
    g_hash_table_iter_init(&iter, mRequestRules);
    while (g_hash_table_iter_next(&iter, &key, &value)) {
      auto* policy = static_cast<Policy*>(value);
      if (!policy->persistent) for (uint32_t i = 0; i < policy->storeIds.Length(); ++i) RemoveStored(policy->stores[i], policy->storeIds[i]);
    }
    g_hash_table_unref(mRequestRules); mRequestRules = nullptr;
  }
  g_clear_object(&mFilterCancellation);
  g_clear_object(&mFilterStore);
  for (auto* store : mAdditionalFilterStores) g_object_unref(store);
  mAdditionalFilterStores.Clear();
}
