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
#include <algorithm>

static constexpr uint32_t kBlocksPerPolicyPart = 8192;
static constexpr uint32_t kConcurrentPolicyCompilations = 4;
struct WPEPolicyCompilation {
  RefPtr<WPEContentView> owner;
  nsCString token;
  nsCString identifier;
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

namespace {
bool NoPatternWhitespace(char16_t) { return false; }
struct Policy {
  uint64_t generation = 0;
  bool enabled = true;
  nsTArray<WebKitUserContentFilter*> filters;
  nsTArray<nsCString> storeIds;
  nsTArray<WebKitUserContentFilterStore*> stores;
  ~Policy() {
    for (auto* filter : filters) webkit_user_content_filter_unref(filter);
    for (auto* store : stores) g_object_unref(store);
  }
};
struct PolicyPart {
  WPEPolicyCompilation* compilation;
  uint32_t index;
  uint32_t slot;
};
void RemoveStored(WebKitUserContentFilterStore* store, const nsCString& id)
{
  if (!id.IsEmpty()) webkit_user_content_filter_store_remove(store, id.get(), nullptr,
    [](GObject* source, GAsyncResult* result, gpointer) {
      GError* error = nullptr;
      webkit_user_content_filter_store_remove_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
      g_clear_error(&error);
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
  // Upstream serializes compilation by store path. A small fixed pool gives
  // bounded parallel compilation and is shared by views using this profile.
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
  char* unique = g_uuid_string_random();
  auto* compilation = new WPEPolicyCompilation;
  compilation->owner = this;
  compilation->token = token;
  compilation->identifier = unique;
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
    nsAutoCString json("[");
    uint32_t block = 0;
    bool included = false;
    for (uint32_t i = 0; i < compilation->rules.Length(); ++i) {
      bool keep;
      if (compilation->allows[i]) keep = included || !compilation->blocks;
      else keep = block++ / kBlocksPerPolicyPart == compilation->part;
      if (!keep) continue;
      if (included) json.Append(',');
      json.Append(compilation->rules[i]);
      included = true;
    }
    json.Append(']');
    nsCString storeId(compilation->identifier);
    storeId.Append('.');
    storeId.AppendInt(compilation->part);
    compilation->storeIds.AppendElement(storeId);
    auto* store = compilation->storePool[slot];
    compilation->stores.AppendElement(WEBKIT_USER_CONTENT_FILTER_STORE(g_object_ref(store)));
    compilation->filters.AppendElement(nullptr);
    auto* part = new PolicyPart{compilation, compilation->part++, slot};
    ++compilation->active;
    GBytes* bytes = g_bytes_new(json.get(), json.Length());
    webkit_user_content_filter_store_save(store, storeId.get(), bytes, compilation->cancellation,
      [](GObject* source, GAsyncResult* result, gpointer data) {
        auto* part = static_cast<PolicyPart*>(data);
        auto* compilation = part->compilation;
        compilation->busy[part->slot] = false;
        --compilation->active;
        GError* error = nullptr;
        auto* filter = webkit_user_content_filter_store_save_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
        if (filter) {
          compilation->filters[part->index] = filter;
          ++compilation->completed;
          RefPtr<nsHashPropertyBag> progress = new nsHashPropertyBag();
          progress->SetPropertyAsUint32(NS_LITERAL_STRING("id"), compilation->request);
          progress->SetPropertyAsDouble(NS_LITERAL_STRING("progress"),
            double(compilation->completed) / std::max(1u, (compilation->blocks + kBlocksPerPolicyPart - 1) / kBlocksPerPolicyPart));
          compilation->owner->Notify("content-view-policy-progress", static_cast<nsIWritablePropertyBag2*>(progress));
        } else {
          if (compilation->error.IsEmpty()) compilation->error.Assign(error ? error->message : "Policy compiler returned no result");
        }
        compilation->owner->CompileNextPolicy(compilation);
        g_clear_error(&error);
        delete part;
      }, part);
    g_bytes_unref(bytes);
  }
}

void WPEContentView::FinishPolicyCompilation(WPEPolicyCompilation* compilation, const char* error)
{
  RefPtr<WPEContentView> owner = this;
  auto* policy = mRequestRules ? static_cast<Policy*>(g_hash_table_lookup(mRequestRules, compilation->token.get())) : nullptr;
  bool current = !mDestroyed && policy && policy->generation == compilation->generation;
  if (current && !*error) {
    auto* manager = webkit_web_view_get_user_content_manager(mHost->webView);
    if (policy->enabled) {
      for (auto* filter : compilation->filters) webkit_user_content_manager_add_filter(manager, filter);
      for (auto* filter : policy->filters) webkit_user_content_manager_remove_filter(manager, filter);
    }
    policy->filters.SwapElements(compilation->filters);
    policy->storeIds.SwapElements(compilation->storeIds);
    policy->stores.SwapElements(compilation->stores);
  } else if (current && policy->filters.IsEmpty())
    g_hash_table_remove(mRequestRules, compilation->token.get());
  for (uint32_t i = 0; i < compilation->storeIds.Length(); ++i)
    RemoveStored(compilation->stores[i], compilation->storeIds[i]);
  RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
  info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), compilation->request);
  info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), NS_LITERAL_CSTRING("null"));
  info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(
    current ? error : "Content policy superseded or view closed"));
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
  for (uint32_t i = 0; i < policy->storeIds.Length(); ++i) RemoveStored(policy->stores[i], policy->storeIds[i]);
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
      for (uint32_t i = 0; i < policy->storeIds.Length(); ++i) RemoveStored(policy->stores[i], policy->storeIds[i]);
    }
    g_hash_table_unref(mRequestRules); mRequestRules = nullptr;
  }
  g_clear_object(&mFilterCancellation);
  g_clear_object(&mFilterStore);
  for (auto* store : mAdditionalFilterStores) g_object_unref(store);
  mAdditionalFilterStores.Clear();
}
