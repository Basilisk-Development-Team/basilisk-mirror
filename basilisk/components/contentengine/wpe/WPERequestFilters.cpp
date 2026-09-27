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

namespace {
bool NoPatternWhitespace(char16_t) { return false; }
struct Policy {
  uint64_t generation = 0;
  WebKitUserContentFilter* filter = nullptr;
  nsCString storeId;
  ~Policy() { if (filter) webkit_user_content_filter_unref(filter); }
};
struct Reply {
  RefPtr<WPEContentView> owner;
  nsCString token;
  nsCString storeId;
  uint64_t generation;
  uint32_t request;
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
  nsAutoCString json("[");
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
    if (i) json.Append(',');
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
    NS_ENSURE_TRUE(json.Length() <= 64 * 1024 * 1024, NS_ERROR_INVALID_ARG);
  }
  json.Append(']');
  nsresult rv = EnsureFilterStore();
  NS_ENSURE_SUCCESS(rv, rv);
  nsCString token(identifier);
  auto* policy = static_cast<Policy*>(g_hash_table_lookup(mRequestRules, token.get()));
  if (!policy) { policy = new Policy(); g_hash_table_insert(mRequestRules, g_strdup(token.get()), policy); }
  policy->generation = ++mFilterGeneration;
  char* unique = g_uuid_string_random();
  auto* reply = new Reply{this, token, nsCString(unique), policy->generation, request};
  g_free(unique);
  GBytes* bytes = g_bytes_new(json.get(), json.Length());
  webkit_user_content_filter_store_save(mFilterStore, reply->storeId.get(), bytes, mFilterCancellation,
    [](GObject* source, GAsyncResult* result, gpointer data) {
      auto* reply = static_cast<Reply*>(data);
      auto* owner = reply->owner.get();
      auto* store = WEBKIT_USER_CONTENT_FILTER_STORE(source);
      GError* error = nullptr;
      auto* filter = webkit_user_content_filter_store_save_finish(store, result, &error);
      auto* policy = owner->mRequestRules ? static_cast<Policy*>(g_hash_table_lookup(owner->mRequestRules, reply->token.get())) : nullptr;
      bool current = !owner->mDestroyed && policy && policy->generation == reply->generation;
      if (current && filter) {
        auto* manager = webkit_web_view_get_user_content_manager(owner->mHost->webView);
        if (policy->filter) {
          webkit_user_content_manager_remove_filter(manager, policy->filter);
          webkit_user_content_filter_unref(policy->filter);
          RemoveStored(store, policy->storeId);
        }
        policy->filter = filter;
        policy->storeId = reply->storeId;
        webkit_user_content_manager_add_filter(manager, filter);
      } else {
        if (filter) webkit_user_content_filter_unref(filter);
        RemoveStored(store, reply->storeId);
        if (current && !policy->filter)
          g_hash_table_remove(owner->mRequestRules, reply->token.get());
      }
      RefPtr<nsHashPropertyBag> info = new nsHashPropertyBag();
      info->SetPropertyAsUint32(NS_LITERAL_STRING("id"), reply->request);
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("json"), NS_LITERAL_CSTRING("null"));
      info->SetPropertyAsAUTF8String(NS_LITERAL_STRING("error"), nsDependentCString(
        !current ? "Content policy superseded or view closed" : error ? error->message : ""));
      owner->Notify("content-view-policy-result", static_cast<nsIWritablePropertyBag2*>(info));
      g_clear_error(&error);
      delete reply;
    }, reply);
  g_bytes_unref(bytes);
  return NS_OK;
}

NS_IMETHODIMP WPEContentView::RemoveRequestRules(const nsACString& identifier)
{
  if (!mRequestRules) return NS_OK;
  nsCString token(identifier);
  auto* policy = static_cast<Policy*>(g_hash_table_lookup(mRequestRules, token.get()));
  if (!policy) return NS_OK;
  if (policy->filter && mHost) webkit_user_content_manager_remove_filter(
    webkit_web_view_get_user_content_manager(mHost->webView), policy->filter);
  RemoveStored(mFilterStore, policy->storeId);
  g_hash_table_remove(mRequestRules, token.get());
  return NS_OK;
}
void WPEContentView::ClearRequestRules()
{
  if (mFilterCancellation) g_cancellable_cancel(mFilterCancellation);
  if (mRequestRules) {
    GHashTableIter iter; gpointer key, value;
    g_hash_table_iter_init(&iter, mRequestRules);
    while (g_hash_table_iter_next(&iter, &key, &value)) RemoveStored(mFilterStore, static_cast<Policy*>(value)->storeId);
    g_hash_table_unref(mRequestRules); mRequestRules = nullptr;
  }
  g_clear_object(&mFilterCancellation);
  g_clear_object(&mFilterStore);
}
