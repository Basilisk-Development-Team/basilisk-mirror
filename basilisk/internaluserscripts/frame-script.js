/* This source file is licensed under the MIT License.
 * A copy of the MIT License should have been distributed with this file.
 * If not, see https://opensource.org/licenses/MIT.
 */

"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/Services.jsm");

const internalUserscripts =
  Cc["@internaluserscripts.mozdev.org/service;1"]
    .getService()
    .wrappedJSObject;

function injectWindow(win) {
  if (!win) {
    return;
  }

  Services.tm.mainThread.dispatch(function () {
    internalUserscripts._inject(win);
  }, Ci.nsIThread.DISPATCH_NORMAL);
}

addEventListener("DOMWindowCreated", function (event) {
  let doc = event.target;
  injectWindow(doc && doc.defaultView);
}, true);

// The delayed frame-script registration also applies to message managers that
// already exist, so cover their current document as well as future ones.
injectWindow(content);
