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
  addEventListener("unload", () => { if (sandbox) Components.utils.nukeSandbox(sandbox); }, false);
})();
