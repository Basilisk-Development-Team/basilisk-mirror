/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// A dedicated ordinary Gecko frame script. Existing extension message names,
// child globals and loadFrameScript semantics are never replaced.
(function() {
  let sandbox, document;
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
  addMessageListener("Basilisk:ContentExecute", message => {
    let {id, source} = message.data;
    if (typeof source != "string" || source.length > 1024 * 1024) return;
    try {
      let current = world();
      let script = "(async function(){let value=await (async function(){\n" + source +
        "\n})();return JSON.stringify(value === undefined ? null : value);})()";
      Promise.resolve(Components.utils.evalInSandbox(script, current, "latest", "basilisk-content-script", 1))
        .then(json => {
          if (document != content.document) throw new Error("Document navigated");
          sendAsyncMessage("Basilisk:ContentResult", {id, json});
        }).catch(error => sendAsyncMessage("Basilisk:ContentResult", {id, error: String(error)}));
    } catch (error) { sendAsyncMessage("Basilisk:ContentResult", {id, error: String(error)}); }
  });
  addEventListener("unload", () => {
    if (sandbox) Components.utils.nukeSandbox(sandbox);
    sandbox = null; document = null;
  }, false);
})();
