/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// Normal upstream WebProcess-extension API. No UXP/XPCOM, policy evaluator,
// synchronous IPC or page-world native bindings live in this module.
#include <wpe/webkit-web-process-extension.h>
#include <jsc/jsc.h>
#include <cstring>

namespace {
WebKitScriptWorld* world;
struct Pending { WebKitUserMessage* message; guint timeout; WebKitScriptWorld* world; bool globalScope; };
struct Frame {
  gint references = 1;
  GWeakRef native, page;
  guint64 nativeId;
  char* token;
  bool valid = true;
  GHashTable* pending;
  GHashTable* worlds;
};
Frame* Ref(Frame* frame) { ++frame->references; return frame; }
void FreePending(gpointer data) {
  auto* pending = static_cast<Pending*>(data);
  if (pending->timeout) g_source_remove(pending->timeout);
  g_object_unref(pending->message);
  g_free(pending);
}
void Unref(gpointer data) {
  auto* frame = static_cast<Frame*>(data);
  if (--frame->references) return;
  g_weak_ref_clear(&frame->native); g_weak_ref_clear(&frame->page);
  g_hash_table_destroy(frame->pending); g_hash_table_destroy(frame->worlds); g_free(frame->token); delete frame;
}
void Reply(WebKitUserMessage* request, const char* json, const char* error) {
  webkit_user_message_send_reply(request, webkit_user_message_new("basilisk:result",
    g_variant_new("(ss)", json, error)));
}
void Invalidate(Frame* frame) {
  auto* page = WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  if (frame->valid && page)
    webkit_web_page_send_message_to_view(page, webkit_user_message_new("basilisk:frame-destroyed",
      g_variant_new("(s)", frame->token)), nullptr, nullptr, nullptr);
  g_clear_object(&page);
  frame->valid = false;
  g_hash_table_remove_all(frame->worlds);
  GHashTableIter it; gpointer key, value;
  g_hash_table_iter_init(&it, frame->pending);
  while (g_hash_table_iter_next(&it, &key, &value)) {
    Reply(static_cast<Pending*>(value)->message, "null", "Frame document destroyed");
    g_hash_table_iter_remove(&it);
  }
}
void RemoveFrame(gpointer value) { Invalidate(static_cast<Frame*>(value)); Unref(value); }
GHashTable* Frames(WebKitWebPage* page) {
  auto* frames = static_cast<GHashTable*>(g_object_get_data(G_OBJECT(page), "basilisk-frames"));
  if (!frames) {
    frames = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, RemoveFrame);
    g_object_set_data_full(G_OBJECT(page), "basilisk-frames", frames,
      +[](gpointer value) { g_hash_table_destroy(static_cast<GHashTable*>(value)); });
  }
  return frames;
}
void Announce(Frame* frame) {
  auto* native = WEBKIT_FRAME(g_weak_ref_get(&frame->native));
  auto* page = WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  if (native && page) {
    const char* uri = webkit_frame_get_uri(native);
    webkit_web_page_send_message_to_view(page, webkit_user_message_new("basilisk:frame-created",
      g_variant_new("(ssbs)", frame->token, uri ? uri : "", webkit_frame_is_main_frame(native), "null")), nullptr, nullptr, nullptr);
  }
  g_clear_object(&native); g_clear_object(&page);
}
void Bridge(const char* kind, const char* json, const char* error, guint id, gpointer data) {
  auto* frame = static_cast<Frame*>(data);
  if (!strcmp(kind, "closed")) {
    auto* page = WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
    if (page) {
      webkit_web_page_send_message_to_view(page, webkit_user_message_new("basilisk:frame-destroyed",
        g_variant_new("(s)", frame->token)), nullptr, nullptr, nullptr);
      g_hash_table_remove(Frames(page), frame->token); g_object_unref(page);
    }
    return;
  }
  if (!strcmp(kind, "resume") && !frame->valid) {
    auto* page = WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
    auto* native = WEBKIT_FRAME(g_weak_ref_get(&frame->native));
    if (page && native) {
      // A trusted pageshow after BFCache restore starts a new addressing epoch.
      frame->valid = true; g_free(frame->token); frame->token = g_uuid_string_random();
      g_hash_table_insert(Frames(page), g_strdup(frame->token), Ref(frame)); Announce(frame);
    }
    g_clear_object(&page); g_clear_object(&native); return;
  }
  if (!frame->valid || !json || strlen(json) > 1024 * 1024) return;
  if (!strcmp(kind, "reply")) {
    auto* pending = static_cast<Pending*>(g_hash_table_lookup(frame->pending, GUINT_TO_POINTER(id)));
    if (pending && (!pending->world || pending->world == world)) { Reply(pending->message, json, error ? error : ""); g_hash_table_remove(frame->pending, GUINT_TO_POINTER(id)); }
    return;
  }
  if (strcmp(kind, "message")) return;
  auto* native = WEBKIT_FRAME(g_weak_ref_get(&frame->native));
  auto* page = WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  if (native && page) {
    const char* uri = webkit_frame_get_uri(native);
    webkit_web_page_send_message_to_view(page, webkit_user_message_new("basilisk:frame-message",
      g_variant_new("(ssbs)", frame->token, uri ? uri : "", webkit_frame_is_main_frame(native), json)),
      nullptr, nullptr, nullptr);
  }
  g_clear_object(&native); g_clear_object(&page);
}
void WindowCleared(WebKitScriptWorld*, WebKitWebPage* page, WebKitFrame* native, gpointer) {
  auto* frames = Frames(page);
  GHashTableIter it; gpointer key, value;
  g_hash_table_iter_init(&it, frames);
  while (g_hash_table_iter_next(&it, &key, &value)) {
    auto* previous = static_cast<Frame*>(value);
    auto* live = g_weak_ref_get(&previous->native);
    bool remove = !live || webkit_frame_is_main_frame(native) || previous->nativeId == webkit_frame_get_id(native);
    g_clear_object(&live);
    if (remove) g_hash_table_iter_remove(&it);
  }
  auto* frame = new Frame();
  g_weak_ref_init(&frame->native, native); g_weak_ref_init(&frame->page, page);
  frame->nativeId = webkit_frame_get_id(native); frame->token = g_uuid_string_random();
  frame->pending = g_hash_table_new_full(g_direct_hash, g_direct_equal, nullptr, FreePending);
  frame->worlds = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_object_unref);
  g_hash_table_insert(frames, g_strdup(frame->token), frame);
  Announce(frame);
  auto* context = webkit_frame_get_js_context_for_script_world(native, world);
  auto* bridge = jsc_value_new_function(context, "bridge", G_CALLBACK(Bridge), Ref(frame), Unref,
    G_TYPE_NONE, 4, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_UINT);
  jsc_context_set_value(context, "__basiliskFrameBridge", bridge);
  g_object_unref(bridge);
  const char* bootstrap = R"JS((function(bridge) {
    delete globalThis.__basiliskFrameBridge;
    const listeners = new Set();
    addEventListener('pagehide', event => {if (event.isTrusted) bridge('closed', '', '', 0);});
    addEventListener('pageshow', event => {if (event.isTrusted) bridge('resume', '', '', 0);});
    Object.defineProperty(globalThis, 'browserContent', {value: Object.freeze({
      sendMessage(value) {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw TypeError('Message must be JSON serializable');
        bridge('message', json, '', 0);
      },
      addMessageListener(fn) {listeners.add(fn);},
      removeMessageListener(fn) {listeners.delete(fn);},
      _dispatch(json) {const value=JSON.parse(json); for(const fn of listeners) fn(value);}
    })});
    // This closure is reachable only by privileged execution in this isolated
    // world. It offers serialized script results, never arbitrary native calls.
    Object.defineProperty(globalThis, '__basiliskReply', {value: function(id, value, error) {
      bridge('reply', JSON.stringify(value === undefined ? null : value), error, id);
    }});
  })(globalThis.__basiliskFrameBridge);)JS";
  auto* result = jsc_context_evaluate(context, bootstrap, -1);
  g_clear_object(&result); g_object_unref(context);
}
struct WorldBinding { Frame* frame; WebKitScriptWorld* world; };
void WorldReply(const char* json, const char* error, guint id, gpointer data) {
  auto* binding = static_cast<WorldBinding*>(data);
  auto* pending = static_cast<Pending*>(g_hash_table_lookup(binding->frame->pending, GUINT_TO_POINTER(id)));
  if (!binding->frame->valid || !pending || pending->globalScope || pending->world != binding->world ||
      !json || strlen(json) > 1024 * 1024) return;
  Reply(pending->message, json, error ? error : "");
  g_hash_table_remove(binding->frame->pending, GUINT_TO_POINTER(id));
}
struct Timeout { Frame* frame; guint id; };
void Execute(Frame* frame, guint id, const char* source, WebKitUserMessage* request, const char* worldId = nullptr, bool globalScope = false) {
  auto* native = WEBKIT_FRAME(g_weak_ref_get(&frame->native));
  if (!frame->valid || !native) { Reply(request, "null", "Unknown or expired frame"); g_clear_object(&native); return; }
  if (g_hash_table_contains(frame->pending, GUINT_TO_POINTER(id))) { Reply(request, "null", "Duplicate request"); g_object_unref(native); return; }
  auto* pending = g_new0(Pending, 1); pending->message = WEBKIT_USER_MESSAGE(g_object_ref(request));
  auto* timeout = new Timeout{Ref(frame), id};
  pending->timeout = g_timeout_add_seconds_full(G_PRIORITY_DEFAULT, 25, +[](gpointer data) -> gboolean {
    auto* timeout = static_cast<Timeout*>(data);
    auto* pending = static_cast<Pending*>(g_hash_table_lookup(timeout->frame->pending, GUINT_TO_POINTER(timeout->id)));
    if (pending) {
      pending->timeout = 0; Reply(pending->message, "null", "Frame execution timed out");
      g_hash_table_remove(timeout->frame->pending, GUINT_TO_POINTER(timeout->id));
    }
    return G_SOURCE_REMOVE;
  }, timeout, +[](gpointer data) {auto* timeout=static_cast<Timeout*>(data);Unref(timeout->frame);delete timeout;});
  g_hash_table_insert(frame->pending, GUINT_TO_POINTER(id), pending);
  WebKitScriptWorld* selectedWorld = world;
  if (worldId) {
    selectedWorld = static_cast<WebKitScriptWorld*>(g_hash_table_lookup(frame->worlds, worldId));
    if (!selectedWorld) {
      if (g_hash_table_size(frame->worlds) >= 64) {
        Reply(request, "null", "Document execution-world limit reached");
        g_hash_table_remove(frame->pending, GUINT_TO_POINTER(id)); g_object_unref(native); return;
      }
      selectedWorld = webkit_script_world_new();
      g_hash_table_insert(frame->worlds, g_strdup(worldId), selectedWorld);
      auto* target = webkit_frame_get_js_context_for_script_world(native, selectedWorld);
      // Only serialized execution completion is exposed, never native invocation.
      auto* binding = new WorldBinding{Ref(frame), selectedWorld};
      auto* bridge = jsc_value_new_function(target, "reply", G_CALLBACK(WorldReply), binding,
        +[](gpointer value) {auto* binding=static_cast<WorldBinding*>(value); Unref(binding->frame); delete binding;},
        G_TYPE_NONE, 3, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_UINT);
      jsc_context_set_value(target, "__basiliskWorldBridge", bridge); g_object_unref(bridge);
      auto* initialized = jsc_context_evaluate(target, R"JS((function(bridge) {
        delete globalThis.__basiliskWorldBridge;
        Object.defineProperty(globalThis, '__basiliskReply', {value: function(id, value, error) {
          bridge(JSON.stringify(value === undefined ? null : value), error, id);
        }});
      })(globalThis.__basiliskWorldBridge);)JS", -1);
      g_clear_object(&initialized); g_object_unref(target);
    }
  }
  pending->world = selectedWorld;
  pending->globalScope = globalScope;
  auto* context = webkit_frame_get_js_context_for_script_world(native, selectedWorld);
  jsc_context_clear_exception(context);
  if (globalScope) {
    auto* value = jsc_context_evaluate_with_source_uri(context, source, -1, "basilisk-legacy-script", 1);
    auto* exception = jsc_context_get_exception(context);
    Reply(request, "null", exception ? jsc_exception_get_message(exception) : "");
    g_hash_table_remove(frame->pending, GUINT_TO_POINTER(id));
    jsc_context_clear_exception(context); g_clear_object(&value); g_object_unref(context); g_object_unref(native); return;
  }
  char* code = g_strdup_printf("(async function(){\n%s\n})().then(value => __basiliskReply(%u, value, '')).catch(error => __basiliskReply(%u, null, String(error)));", source, id, id);
  auto* result = jsc_context_evaluate_with_source_uri(context, code, -1, "basilisk-frame-script", 1);
  g_free(code);
  if (auto* error = jsc_context_get_exception(context)) {
    Reply(request, "null", jsc_exception_get_message(error));
    g_hash_table_remove(frame->pending, GUINT_TO_POINTER(id)); jsc_context_clear_exception(context);
  }
  g_clear_object(&result); g_object_unref(context); g_object_unref(native);
}
gboolean Message(WebKitWebPage* page, WebKitUserMessage* request, gpointer) {
  const char* name = webkit_user_message_get_name(request);
  if (!strcmp(name, "basilisk:frames")) {
    auto* context = jsc_context_new(); auto* list = jsc_value_new_array(context, G_TYPE_NONE); guint index = 0;
    GHashTableIter it; gpointer key, value; g_hash_table_iter_init(&it, Frames(page));
    while (g_hash_table_iter_next(&it, &key, &value)) {
      auto* frame = static_cast<Frame*>(value); auto* native = WEBKIT_FRAME(g_weak_ref_get(&frame->native));
      if (!native) {g_hash_table_iter_remove(&it);continue;}
      auto* item = jsc_value_new_object(context, nullptr, nullptr);
      auto* id = jsc_value_new_string(context, frame->token);
      const char* uri = webkit_frame_get_uri(native);
      auto* url = jsc_value_new_string(context, uri ? uri : "");
      auto* top = jsc_value_new_boolean(context, webkit_frame_is_main_frame(native));
      jsc_value_object_set_property(item, "frameId", id); jsc_value_object_set_property(item, "documentURI", url);
      jsc_value_object_set_property(item, "isTopFrame", top); jsc_value_object_set_property_at_index(list, index++, item);
      g_object_unref(item); g_object_unref(id); g_object_unref(url); g_object_unref(top); g_object_unref(native);
    }
    char* json = jsc_value_to_json(list, 0); Reply(request, json ? json : "[]", "");
    g_free(json); g_object_unref(list); g_object_unref(context); return TRUE;
  }
  if (!strcmp(name, "basilisk:world-execute")) {
    auto* parameters = webkit_user_message_get_parameters(request);
    if (!parameters || !g_variant_is_of_type(parameters, G_VARIANT_TYPE("(usssb)"))) {
      Reply(request, "null", "Invalid world operation"); return TRUE;
    }
    guint id; const char *token, *key, *source; gboolean globalScope;
    g_variant_get(parameters, "(u&s&s&sb)", &id, &token, &key, &source, &globalScope);
    if (!*key || strlen(key) > 128 || strlen(source) > 1024 * 1024) {
      Reply(request, "null", "Invalid world or script"); return TRUE;
    }
    auto* frame = static_cast<Frame*>(g_hash_table_lookup(Frames(page), token));
    if (!frame) Reply(request, "null", "Unknown or expired frame");
    else Execute(frame, id, source, request, key, globalScope);
    return TRUE;
  }
  if (strcmp(name, "basilisk:execute")) return FALSE;
  auto* parameters = webkit_user_message_get_parameters(request);
  if (!parameters || !g_variant_is_of_type(parameters, G_VARIANT_TYPE("(uss)"))) { Reply(request, "null", "Invalid frame request"); return TRUE; }
  guint id; const char *token, *source; g_variant_get(parameters, "(u&s&s)", &id, &token, &source);
  if (strlen(source) > 1024 * 1024) {Reply(request, "null", "Script too large");return TRUE;}
  auto* frame = static_cast<Frame*>(g_hash_table_lookup(Frames(page), token));
  if (!frame) Reply(request, "null", "Unknown or expired frame"); else Execute(frame, id, source, request);
  return TRUE;
}
}
extern "C" __attribute__((visibility("default")))
void webkit_web_process_extension_initialize(WebKitWebProcessExtension* extension)
{
  world = webkit_script_world_new_with_name("basilisk-content");
  g_signal_connect(world, "window-object-cleared", G_CALLBACK(WindowCleared), nullptr);
  g_signal_connect(extension, "page-created", G_CALLBACK(+[](WebKitWebProcessExtension*, WebKitWebPage* page, gpointer) {
    g_signal_connect(page, "user-message-received", G_CALLBACK(Message), nullptr);
  }), nullptr);
}
