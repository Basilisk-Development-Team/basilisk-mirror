/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
Components.utils.import("resource://gre/modules/Services.jsm");
let chromeErrors = [];
let consoleListener = { observe(message) {
  if (!(message instanceof Components.interfaces.nsIScriptError)) return;
  if (message.flags & Components.interfaces.nsIScriptError.warningFlag) return;
  if (message.sourceName.startsWith("chrome://browser/content/"))
    chromeErrors.push(message.message);
} };
Services.console.registerListener(consoleListener);
window.addEventListener("load", function() {
  let base = "http://127.0.0.1:" + Services.prefs.getIntPref("wpe.test.port") + "/";
  let browserWindow = window.openDialog("chrome://browser/content/browser.xul", "_blank",
                                       "chrome,all,dialog=no", base + "a");
  let observer = function(subject, topic) {
    if (subject != browserWindow) return;
    Services.obs.removeObserver(observer, topic);
    browserWindow.setTimeout(function() {
      try {
        let win = browserWindow;
        if (win.ContentEngines.engineFor(win.gBrowser.selectedBrowser) != "gecko")
          throw new Error("Gecko is not the default");
        win.ContentEngines.open(base + "a");
        win.ContentEngines.open(base + "b", false);
        Services.scriptloader.loadSubScript("chrome://browser/content/contentengine/wpe-mixed-operations.js", win);
        win.testMixedTabs().then(result => {
          if (chromeErrors.length) { fail(new Error(chromeErrors.join("\n"))); return; }
          dump("WPE-MIXED PASS " + JSON.stringify(result) + "\n");
          Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
        }, fail);
      } catch (error) { fail(error); }
    }, 500);
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished", false);
});
function fail(error) {
  dump("WPE-MIXED FAIL " + error + "\n" + error.stack + "\n");
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
