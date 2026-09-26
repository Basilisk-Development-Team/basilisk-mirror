/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// An opt-in ordinary Gecko frame script, separate from existing extensions'
// child globals and message names. These are real Gecko documents/sandboxes.
(function() {
  const C = Components, Ci = C.interfaces, Cu = C.utils;
  const {Services} = Cu.import("resource://gre/modules/Services.jsm", {});
  const frames = new Map(), styles = new Map(), scripts = new Map();
  function belongs(win) { try { return win && win.top == content; } catch (_) { return false; } }
  function current(frame) { try { return belongs(frame.win) && frame.doc == frame.win.document; } catch (_) { return false; } }
  function dispose(frame) {
    for (let id of frame.pending) result(id, null, "Frame document destroyed");
    frame.pending.clear();
    if (frame.sandbox) Cu.nukeSandbox(frame.sandbox);
    frames.delete(frame.id);
  }
  function record(win) {
    for (let frame of frames.values()) {
      if (!current(frame)) dispose(frame);
      else if (frame.doc == win.document) return frame;
    }
    let frame = {id:C.classes["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator).generateUUID().toString(), win, doc:win.document, applied:new Map(), pending:new Set()};
    frames.set(frame.id, frame); return frame;
  }
  function metadata(frame) { return {frameId:frame.id, documentURI:frame.doc.documentURI, isTopFrame:frame.win == content}; }
  function world(frame) {
    if (!frame.sandbox) {
      let sandbox = frame.sandbox = Cu.Sandbox(frame.win, {sandboxPrototype:frame.win,
        wantXrays:true, wantComponents:false, sandboxName:"Basilisk content bridge"});
      Cu.exportFunction(json => {
        if (current(frame) && typeof json == "string" && json.length <= 1024 * 1024)
          sendAsyncMessage("Basilisk:ContentMessage", {json, frame:metadata(frame)});
      }, sandbox, {defineAs:"__basiliskPost"});
      Cu.evalInSandbox(`(function() {
        Object.defineProperty(this, 'Components', {value:undefined});
        const listeners = new Set();
        Object.defineProperty(this, 'browserContent', {value:Object.freeze({
          sendMessage(value) {
            const json=JSON.stringify(value);
            if(typeof json!='string') throw TypeError('Message must be JSON serializable');
            __basiliskPost(json);
          },
          addMessageListener(fn) {listeners.add(fn);},
          removeMessageListener(fn) {listeners.delete(fn);},
          _dispatch(json) {const value=JSON.parse(json);for(const fn of listeners) fn(value);}
        })});
      }).call(this);`, sandbox);
    }
    return frame.sandbox;
  }
  function result(id, json, error) { sendAsyncMessage("Basilisk:ContentResult", {id, json, error}); }
  function execute({id, source, frameId}, selected) {
    try {
      if (typeof source != "string" || source.length > 1024 * 1024) throw Error("Invalid script");
      let frame = selected || (frameId === undefined ? record(content) : frames.get(frameId));
      if (!frame || !current(frame)) throw Error("Unknown or expired frame");
      if (id) frame.pending.add(id);
      let code = "(async function(){let value=await (async function(){\n" + source +
        "\n})();return JSON.stringify(value===undefined?null:value);})()";
      Promise.resolve(Cu.evalInSandbox(code, world(frame), "latest", "basilisk-content-script", 1)).then(json => {
        if (!current(frame)) throw Error("Document navigated");
        frame.pending.delete(id); result(id, json);
      }).catch(error => {frame.pending.delete(id); result(id, null, String(error));});
    } catch (error) { result(id, null, String(error)); }
  }
  function documents(win = content, list = []) {
    if (!belongs(win)) return list;
    list.push(record(win));
    for (let i=0; i<win.frames.length; ++i) documents(win.frames[i], list);
    return list;
  }
  function applyStyle(frame, token, definition) {
    if (!current(frame)) return;
    let utils=frame.win.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
    if (frame.applied.has(token)) utils.removeSheetUsingURIString(frame.applied.get(token), utils.USER_SHEET);
    frame.applied.delete(token);
    if (definition && (definition.allFrames || frame.win == content)) {
      let uri="data:text/css;charset=utf-8,"+encodeURIComponent(definition.source);
      utils.loadSheetUsingURIString(uri, utils.USER_SHEET); frame.applied.set(token,uri);
    }
  }
  addMessageListener("Basilisk:ContentFrames", message => {
    try { result(message.data.id, JSON.stringify(documents().map(metadata))); }
    catch(error) {result(message.data.id,null,String(error));}
  });
  addMessageListener("Basilisk:ContentExecute", message => execute(message.data));
  addMessageListener("Basilisk:ContentCSS", message => {
    let {id,token,source,allFrames,remove}=message.data;
    try {
      if(remove) styles.delete(token);else styles.set(token,{source,allFrames});
      for(let frame of documents()) applyStyle(frame,token,styles.get(token));
      result(id,"null");
    } catch(error) {result(id,null,String(error));}
  });
  addMessageListener("Basilisk:ContentRegister", message => {
    let {id,token,source,allFrames,runAt,remove}=message.data;
    if(remove) scripts.delete(token);else scripts.set(token,{source,allFrames,runAt:runAt===undefined?1:runAt});
    result(id,"null");
  });
  function phase(doc, runAt) {
    if (!belongs(doc.defaultView)) return;
    let frame=record(doc.defaultView);
    if(runAt==0) for(let [token,definition] of styles) applyStyle(frame,token,definition);
    for(let definition of scripts.values())
      if(definition.runAt==runAt && (definition.allFrames || frame.win==content)) execute({id:0,source:definition.source},frame);
  }
  const observer={observe:doc=>phase(doc,0)};
  Services.obs.addObserver(observer,"document-element-inserted",false);
  addEventListener("DOMContentLoaded", event => {
    let doc=event.target;
    if(!belongs(doc.defaultView)) return;
    phase(doc,1);
    content.setTimeout(()=> {if(doc.defaultView && doc.defaultView.document==doc) phase(doc,2);},0);
  },true);
  addEventListener("pagehide",event=>{
    for(let frame of frames.values()) if(frame.doc==event.target) dispose(frame);
  },true);
  function reset() {
    for(let frame of frames.values()) {
      if(current(frame)) for(let token of styles.keys()) applyStyle(frame,token);
      dispose(frame);
    }
    styles.clear();scripts.clear();
  }
  addMessageListener("Basilisk:ContentReset",reset);
  addEventListener("unload",()=>{
    Services.obs.removeObserver(observer,"document-element-inserted");reset();
  },false);
})();
