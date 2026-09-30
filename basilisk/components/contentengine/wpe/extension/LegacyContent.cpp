/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "LegacyContent.h"
#include <jsc/jsc.h>
#include <cstring>
#include <vector>
namespace {
WebKitScriptWorld* legacyWorld;
struct LegacyFrame {
  unsigned refs=1;
  bool valid=true;
  GWeakRef page,frame,context;
  GHashTable* sandboxes;
};
LegacyFrame* Retain(LegacyFrame* frame) {++frame->refs;return frame;}
void Release(gpointer);
struct LegacySandbox {JSCContext* context;LegacyFrame* document;};
void ReleaseSandbox(gpointer data) {
  auto* sandbox=static_cast<LegacySandbox*>(data);
  g_object_unref(sandbox->context);Release(sandbox->document);delete sandbox;
}
void Release(gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  if (--frame->refs) return;
  g_weak_ref_clear(&frame->page);g_weak_ref_clear(&frame->frame);g_weak_ref_clear(&frame->context);
  g_hash_table_destroy(frame->sandboxes);delete frame;
}
void Invalidate(gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);frame->valid=false;
  g_hash_table_remove_all(frame->sandboxes);Release(frame);
}
GHashTable* Frames(WebKitWebPage* page) {
  auto* frames=static_cast<GHashTable*>(g_object_get_data(G_OBJECT(page),"basilisk-legacy-frames"));
  if (!frames) {
    frames=g_hash_table_new_full(g_int64_hash,g_int64_equal,g_free,Invalidate);
    g_object_set_data_full(G_OBJECT(page),"basilisk-legacy-frames",frames,
      +[](gpointer value) {g_hash_table_destroy(static_cast<GHashTable*>(value));});
  }
  return frames;
}
JSCContext* Context(LegacyFrame* frame) {
  auto* native=WEBKIT_FRAME(g_weak_ref_get(&frame->frame));
  auto* context=frame->valid && native ? webkit_frame_get_js_context_for_script_world(native,legacyWorld) : nullptr;
  g_clear_object(&native);return context;
}
char* Host(const char* json,gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  auto* page=WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  if (!frame->valid || !page || !json || strlen(json)>4*1024*1024) {
    g_clear_object(&page);return g_strdup("{\"error\":\"Expired content service\"}");
  }
  GError* error=nullptr;
  auto* reply=webkit_web_page_send_message_to_view_sync(page,
    webkit_user_message_new("basilisk:legacy-call",g_variant_new("(s)",json)),&error);
  char* result=nullptr;
  auto* parameters=reply ? webkit_user_message_get_parameters(reply) : nullptr;
  if (parameters && g_variant_is_of_type(parameters,G_VARIANT_TYPE("(s)")))
    g_variant_get(parameters,"(s)",&result);
  g_clear_error(&error);g_clear_object(&reply);g_object_unref(page);
  return result ? result : g_strdup("{\"error\":\"Content host did not reply\"}");
}
JSCValue* Shared(gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  auto* page=WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  if(!frame->valid||!page){g_clear_object(&page);return nullptr;}
  auto* shared=static_cast<JSCValue*>(g_object_get_data(G_OBJECT(page),"basilisk-legacy-shared"));
  if(!shared) {
    auto* context=Context(frame);shared=jsc_value_new_object(context,nullptr,nullptr);g_object_unref(context);
    g_object_set_data_full(G_OBJECT(page),"basilisk-legacy-shared",shared,g_object_unref);
  }
  g_object_ref(shared);g_object_unref(page);return shared;
}
JSCValue* Sandbox(const char* targetId,gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  auto* page=WEBKIT_WEB_PAGE(g_weak_ref_get(&frame->page));
  auto idNumber=targetId&&*targetId ? g_ascii_strtoull(targetId,nullptr,10) : 0;
  auto* target=page&&idNumber ? static_cast<LegacyFrame*>(g_hash_table_lookup(Frames(page),&idNumber)) : frame;
  auto* native=target&&target->valid ? WEBKIT_FRAME(g_weak_ref_get(&target->frame)) : nullptr;
  g_clear_object(&page);
  if (!frame->valid || !native) {g_clear_object(&native);return nullptr;}
  char* id=g_uuid_string_random();
  auto* world=webkit_script_world_new_with_name(id);
  auto* context=webkit_frame_get_js_context_for_script_world(native,world);
  g_hash_table_insert(frame->sandboxes,g_strdup(id),new LegacySandbox{context,Retain(target)});
  auto* global=jsc_context_get_global_object(context);
  auto* pageContext=webkit_frame_get_js_context(native);
  auto* pageWindow=jsc_context_get_global_object(pageContext);
  jsc_value_object_set_property(global,"wrappedJSObject",pageWindow);
  g_object_unref(pageWindow);g_object_unref(pageContext);
  auto* key=jsc_value_new_string(context,id);
  jsc_value_object_set_property(global,"__basiliskSandboxId",key);
  g_object_unref(key);g_free(id);g_object_unref(world);g_object_unref(native);
  return global;
}
JSCValue* Evaluate(const char* source,const char* uri,const char* id,gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  auto* main=Context(frame);
  auto* sandbox=id&&*id ? static_cast<LegacySandbox*>(g_hash_table_lookup(frame->sandboxes,id)) : nullptr;
  auto* target=id&&*id ? (sandbox&&sandbox->document->valid ? sandbox->context : nullptr) : main;
  if (!frame->valid || !target || !source || strlen(source)>4*1024*1024) {
    if (main) jsc_context_throw(main,"Expired or invalid content evaluation");
    g_clear_object(&main);return nullptr;
  }
  auto* result=jsc_context_evaluate_with_source_uri(target,source,-1,uri ? uri : "",1);
  if (auto* error=jsc_context_get_exception(target)) {
    if (g_getenv("BASILISK_LEGACY_DEBUG"))
      g_warning("Content script evaluation failed (%s): %s",uri ? uri : "",jsc_exception_get_message(error));
  }
  if (target!=main && jsc_context_get_exception(target)) {
    const char* message=jsc_exception_get_message(jsc_context_get_exception(target));
    jsc_context_throw(main,message);jsc_context_clear_exception(target);
  }
  g_clear_object(&main);return result;
}
void Style(const char* id,const char* source,gboolean remove,gpointer data) {
  auto* frame=static_cast<LegacyFrame*>(data);
  auto* native=WEBKIT_FRAME(g_weak_ref_get(&frame->frame));
  if (frame->valid && native && id && source)
    webkit_frame_set_user_style(native,id,remove ? nullptr : source);
  g_clear_object(&native);
}
void Cleared(WebKitScriptWorld*,WebKitWebPage* page,WebKitFrame* native,gpointer) {
  auto* frames=Frames(page);
  if (webkit_frame_is_main_frame(native)) {
    g_hash_table_remove_all(frames);
    g_object_set_data(G_OBJECT(page),"basilisk-legacy-shared",nullptr);
  }
  auto id=webkit_frame_get_id(native);
  g_hash_table_remove(frames,&id);
  auto* frame=new LegacyFrame();
  auto* context=webkit_frame_get_js_context_for_script_world(native,legacyWorld);
  g_weak_ref_init(&frame->page,page);g_weak_ref_init(&frame->frame,native);g_weak_ref_init(&frame->context,context);
  frame->sandboxes=g_hash_table_new_full(g_str_hash,g_str_equal,g_free,ReleaseSandbox);
  auto* key=g_new(guint64,1);*key=id;g_hash_table_insert(frames,key,frame);
  auto* functions=jsc_value_new_object(context,nullptr,nullptr);
  auto set=[&](const char* name,JSCValue* value) {jsc_value_object_set_property(functions,name,value);g_object_unref(value);};
  set("host",jsc_value_new_function(context,"host",G_CALLBACK(Host),Retain(frame),Release,G_TYPE_STRING,1,G_TYPE_STRING));
  set("sandbox",jsc_value_new_function(context,"sandbox",G_CALLBACK(Sandbox),Retain(frame),Release,JSC_TYPE_VALUE,1,G_TYPE_STRING));
  set("shared",jsc_value_new_function(context,"shared",G_CALLBACK(Shared),Retain(frame),Release,JSC_TYPE_VALUE,0));
  set("evaluate",jsc_value_new_function(context,"evaluate",G_CALLBACK(Evaluate),Retain(frame),Release,JSC_TYPE_VALUE,3,G_TYPE_STRING,G_TYPE_STRING,G_TYPE_STRING));
  set("style",jsc_value_new_function(context,"style",G_CALLBACK(Style),Retain(frame),Release,G_TYPE_NONE,3,G_TYPE_STRING,G_TYPE_STRING,G_TYPE_BOOLEAN));
  set("frameId",jsc_value_new_number(context,id));
  set("parentFrameId",jsc_value_new_number(context,webkit_frame_get_parent_id(native)));
  set("isTop",jsc_value_new_boolean(context,webkit_frame_is_main_frame(native)));
  jsc_context_set_value(context,"__basiliskLegacyNative",functions);g_object_unref(functions);
  const char* source=
#include "LegacyContent.inc"
  ;
  auto* value=jsc_context_evaluate_with_source_uri(context,source,-1,"basilisk-legacy-runtime",1);
  if (auto* error=jsc_context_get_exception(context)) {
    g_warning("Legacy content bootstrap failed: %s",jsc_exception_get_message(error));
    jsc_context_clear_exception(context);
  }
  g_clear_object(&value);g_object_unref(context);
}
}
void InitializeLegacyContent(WebKitWebPage* page) {
  if (!legacyWorld) {
    legacyWorld=webkit_script_world_new_with_name("basilisk-legacy");
    webkit_script_world_set_cross_origin_access(legacyWorld,TRUE);
    g_signal_connect(legacyWorld,"window-object-cleared",G_CALLBACK(Cleared),nullptr);
  }
  webkit_web_page_add_user_script(page,legacyWorld,
    "globalThis.__basiliskLegacy && __basiliskLegacy.documentStart();",FALSE);
  webkit_web_page_add_user_script(page,legacyWorld,
    "globalThis.__basiliskLegacy && __basiliskLegacy.documentEnd();",TRUE);
  g_signal_connect(page,"resource-policy",G_CALLBACK(+[](WebKitWebPage* page,WebKitFrame* native,WebKitURIRequest* request,guint type,gpointer)->gboolean {
    auto id=webkit_frame_get_id(native);
    auto* frame=static_cast<LegacyFrame*>(g_hash_table_lookup(Frames(page),&id));
    if (!frame || !frame->valid) return FALSE;
    auto* context=Context(frame);
    if (!context) return FALSE;
    auto* runtime=jsc_context_get_value(context,"__basiliskLegacy");
    if (!jsc_value_is_object(runtime)) {g_object_unref(runtime);g_object_unref(context);return FALSE;}
    auto* result=jsc_value_object_invoke_method(runtime,"resourcePolicy",G_TYPE_STRING,
      webkit_uri_request_get_uri(request),G_TYPE_UINT,type,G_TYPE_NONE);
    bool allowed=result && jsc_value_to_boolean(result);
    if (auto* error=jsc_context_get_exception(context)) {
      g_warning("Content resource policy failed: %s",jsc_exception_get_message(error));
      jsc_context_clear_exception(context);allowed=false;
    }
    g_clear_object(&result);g_object_unref(runtime);g_object_unref(context);return !allowed;
  }),nullptr);
  g_signal_connect(page,"user-message-received",G_CALLBACK(+[](WebKitWebPage* page,WebKitUserMessage* message,gpointer)->gboolean {
    if (strcmp(webkit_user_message_get_name(message),"basilisk:legacy-message")) return FALSE;
    auto* parameters=webkit_user_message_get_parameters(message);
    if (!parameters || !g_variant_is_of_type(parameters,G_VARIANT_TYPE("(s)"))) return TRUE;
    const char* json;g_variant_get(parameters,"(&s)",&json);
    if (strlen(json)>4*1024*1024) return TRUE;
    // A synchronous host call can pump IPC and navigate the page. Keep a
    // retained snapshot instead of iterating a table that script may mutate.
    std::vector<LegacyFrame*> recipients;
    GHashTableIter iterator;gpointer key;gpointer value;g_hash_table_iter_init(&iterator,Frames(page));
    while (g_hash_table_iter_next(&iterator,&key,&value))
      recipients.push_back(Retain(static_cast<LegacyFrame*>(value)));
    for (auto* frame : recipients) {
      auto* context=Context(frame);
      if (!frame->valid || !context) {g_clear_object(&context);continue;}
      auto* runtime=jsc_context_get_value(context,"__basiliskLegacy");
      auto* messageValue=jsc_value_new_from_json(context,json);
      auto* result=jsc_value_object_invoke_method(runtime,"receive",JSC_TYPE_VALUE,messageValue,G_TYPE_NONE);
      if (auto* error=jsc_context_get_exception(context)) {
        g_warning("Legacy content message failed: %s",jsc_exception_get_message(error));jsc_context_clear_exception(context);
      }
      g_clear_object(&result);g_object_unref(messageValue);g_object_unref(runtime);g_object_unref(context);
    }
    for (auto* frame : recipients) Release(frame);
    return TRUE;
  }),nullptr);
}
