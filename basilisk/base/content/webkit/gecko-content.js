/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// A dedicated ordinary Gecko frame script. Existing extension message names,
// child globals and loadFrameScript semantics are never replaced.
(function() {
  let sandbox, document, styleDocument;
  const styles = new Map(), scripts = new Map(), applied = new Map();
  function world() {
    if (document != content.document) {
      if (sandbox) Components.utils.nukeSandbox(sandbox);
      document = content.document;
      sandbox = Components.utils.Sandbox(content, {
        sandboxPrototype: content, wantXrays: true, wantComponents: false,
        sandboxName: "Basilisk content bridge"
      });
      let currentDocument = document;
      Components.utils.exportFunction(json => {
        if (currentDocument == content.document && typeof json == "string" && json.length <= 1024 * 1024)
          sendAsyncMessage("Basilisk:ContentMessage", {json});
      }, sandbox, {defineAs: "__basiliskPost"});
      Components.utils.evalInSandbox(`(function() {
        const listeners = new Set();
        Object.defineProperty(this, 'browserContent', {value: Object.freeze({
          sendMessage(value) {
            const json = JSON.stringify(value);
            if (typeof json !== 'string') throw new TypeError('Message must be JSON serializable');
            __basiliskPost(json);
          },
          addMessageListener(fn) { listeners.add(fn); },
          removeMessageListener(fn) { listeners.delete(fn); },
          _dispatch(json) { const value = JSON.parse(json); for (const fn of listeners) fn(value); }
        })});
      }).call(this);`, sandbox);
    }
    return sandbox;
  }
  function execute({id, source}) {
    if (typeof source != "string" || source.length > 1024 * 1024) return;
    try {
      let current = world();
      let requestedDocument = document;
      let script = "(async function(){let value=await (async function(){\n" + source +
        "\n})();return JSON.stringify(value === undefined ? null : value);})()";
      Promise.resolve(Components.utils.evalInSandbox(script, current, "latest", "basilisk-content-script", 1))
        .then(json => {
          if (requestedDocument != content.document) throw new Error("Document navigated");
          sendAsyncMessage("Basilisk:ContentResult", {id, json});
        }).catch(error => sendAsyncMessage("Basilisk:ContentResult", {id, error: String(error)}));
    } catch (error) { sendAsyncMessage("Basilisk:ContentResult", {id, error: String(error)}); }
  }
  addMessageListener("Basilisk:ContentExecute", message => execute(message.data));
  function styleUtils() {
    if (styleDocument != content.document) { styleDocument = content.document; applied.clear(); }
    return content.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
      .getInterface(Components.interfaces.nsIDOMWindowUtils);
  }
  function applyStyle(token, source) {
    let utils = styleUtils();
    if (applied.has(token)) utils.removeSheetUsingURIString(applied.get(token), utils.USER_SHEET);
    applied.delete(token);
    if (source !== undefined) {
      let uri = "data:text/css;charset=utf-8," + encodeURIComponent(source);
      utils.loadSheetUsingURIString(uri, utils.USER_SHEET);
      applied.set(token, uri);
    }
  }
  addMessageListener("Basilisk:ContentCSS", message => {
    let {id, token, source, remove} = message.data;
    try {
      if (remove) styles.delete(token); else styles.set(token, source);
      applyStyle(token, remove ? undefined : source);
      sendAsyncMessage("Basilisk:ContentResult", {id, json: "null"});
    } catch (error) { sendAsyncMessage("Basilisk:ContentResult", {id, error: String(error)}); }
  });
  addMessageListener("Basilisk:ContentRegister", message => {
    let {id, token, source, remove} = message.data;
    if (remove) scripts.delete(token); else scripts.set(token, source);
    sendAsyncMessage("Basilisk:ContentResult", {id, json: "null"});
  });
  addMessageListener("Basilisk:ContentReset", () => {
    for (let token of styles.keys()) applyStyle(token, undefined);
    styles.clear(); scripts.clear();
    if (sandbox) Components.utils.nukeSandbox(sandbox);
    sandbox = null; document = null;
  });
  addEventListener("DOMContentLoaded", event => {
    if (event.target != content.document) return;
    for (let [token, source] of styles) applyStyle(token, source);
    for (let source of scripts.values()) execute({id: 0, source});
  }, true);
  addEventListener("unload", () => {
    if (sandbox) Components.utils.nukeSandbox(sandbox);
    sandbox = null; document = null;
  }, false);
})();
