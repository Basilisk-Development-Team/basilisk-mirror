/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/osfile.jsm");
const Ci = Components.interfaces;
const base = "http://127.0.0.1:" + Services.prefs.getIntPref("wpe.test.port") + "/";
const phase = Services.prefs.getCharPref("wpe.test.phase");
function waitFor(test, message) {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    let timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (++ticks > 300) throw new Error("timeout: " + message);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 100);
  });
}
function finish(error) {
  dump("WPE-PERSISTENCE " + (error ? "FAIL " + error + "\n" + error.stack : "PASS " + phase) + "\n");
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
window.addEventListener("load", function() {
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", "about:blank");
  let observer = function(subject, topic) {
    if (subject != win) return;
    Services.obs.removeObserver(observer, topic);
    win.setTimeout(() => run(win).then(() => finish(), finish), 500);
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished", false);
});
async function run(win) {
  let g = win.gBrowser;
  let engines = win.ContentEngines;
  let stateFile = OS.Path.join(OS.Constants.Path.profileDir, "wpe-test-session.json");
  if (phase == "write") {
    g.selectedBrowser.loadURI(base + "gecko");
    let a = engines.open(base + "write");
    await waitFor(() => a.linkedBrowser.contentTitle == "Stored", "write cookies/localStorage/IndexedDB");
    g.pinTab(a);
    let b = engines.open(base + "read");
    await waitFor(() => b.linkedBrowser.contentTitle == "Read:cookie:local:indexed", "shared WPE session");
    let state = win.SessionStore.getBrowserState();
    await OS.File.writeAtomic(stateFile, new TextEncoder().encode(state));
    if (JSON.parse(state).windows[0].tabs.filter(t => t.extData && t.extData["basilisk.contentEngine"] == "webkit").length != 2)
      throw new Error("engine metadata missing");
  } else {
    let bytes = await OS.File.read(stateFile);
    win.SessionStore.setBrowserState(new TextDecoder().decode(bytes));
    await waitFor(() => g.tabs.length == 3 && engines.views.size == 2, "mixed restore");
    await waitFor(() => g.selectedBrowser.contentTitle == "Read:cookie:local:indexed", "persistent data after restart");
    if (!g.tabs[0].pinned || g.tabs[0].linkedBrowser.contentEngine != "webkit" ||
        g.tabs[1].linkedBrowser.contentEngine != "gecko" || g.selectedTab != g.tabs[2])
      throw new Error("restored engine/order/pinning/selection mismatch");
    // Normal second windows must share cookies; private windows must not.
    let privateWin = win.OpenBrowserWindow({private: true});
    await waitFor(() => privateWin.gBrowser && privateWin.gBrowserInit.delayedStartupFinished,
                  "private window startup");
    let privateTab = privateWin.ContentEngines.open(base + "read");
    await waitFor(() => privateTab.linkedBrowser.contentTitle.startsWith("Read:"), "private data read");
    if (privateTab.linkedBrowser.contentTitle != "Read:none:none:none")
      throw new Error("normal storage leaked into private browsing");
    privateWin.ContentEngines.get().loadURI(base + "write-private");
    await waitFor(() => privateTab.linkedBrowser.contentTitle == "Private stored", "private write");
    privateWin.close();
    await waitFor(() => privateWin.closed, "private close");
    let reopened = win.OpenBrowserWindow({private: true});
    await waitFor(() => reopened.gBrowser && reopened.gBrowserInit.delayedStartupFinished,
                  "private reopen");
    let tab = reopened.ContentEngines.open(base + "read");
    await waitFor(() => tab.linkedBrowser.contentTitle.startsWith("Read:"), "private reread");
    if (tab.linkedBrowser.contentTitle != "Read:none:none:none")
      throw new Error("private storage survived last private window");
    reopened.close();
    // Exercise the same tab transfer entry point used by drag/drop, retaining
    // the shared normal data store while recreating native views per window.
    let other = win.OpenBrowserWindow();
    await waitFor(() => other.gBrowser && other.gBrowserInit.delayedStartupFinished, "adoption window");
    let moved = g.selectedTab;
    g.moveTabTo(moved, 1);
    if (moved._tPos != 1) throw new Error("same-window move failed");
    for (let cycle = 0; cycle < 10; ++cycle) {
      moved = other.gBrowser.adoptTab(moved, 1, true);
      await waitFor(() => moved.linkedBrowser.contentTitle == "Read:cookie:local:indexed" &&
                    other.ContentEngines.get(moved.linkedBrowser), "adopt out");
      moved = g.adoptTab(moved, 2, true);
      await waitFor(() => moved.linkedBrowser.contentTitle == "Read:cookie:local:indexed" &&
                    engines.get(moved.linkedBrowser), "adopt back");
    }
    other.close();
    let detached = g.replaceTabWithWindow(moved);
    await waitFor(() => detached.gBrowser && detached.ContentEngines.get() &&
                  detached.gBrowser.selectedBrowser.contentTitle == "Read:cookie:local:indexed", "detach");
    detached.close();
  }
}
