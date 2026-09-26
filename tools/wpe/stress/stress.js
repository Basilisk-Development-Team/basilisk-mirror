/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
function waitFor(test, label) {
  return new Promise((resolve, reject) => {
    let start = Date.now();
    let timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (Date.now()-start > 60000) throw new Error("Timeout: " + label);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 100);
  });
}
function check(value, label) { if (!value) throw new Error(label); }
function inspectors() {
  let count = 0, all = Services.wm.getEnumerator("Basilisk:WebInspector");
  while (all.hasMoreElements()) { if (!all.getNext().closed) count++; }
  return count;
}
function finish(error) {
  dump("WPE-STRESS " + (error ? "FAIL " + error + "\n" + error.stack : "PASS all") + "\n");
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
window.addEventListener("load", () => run().then(() => finish(), finish));
async function run() {
  const base = "http://127.0.0.1:" + Services.prefs.getIntPref("wpe.test.port") + "/";
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", base + "a");
  await waitFor(() => win.gBrowser && win.gBrowserInit.delayedStartupFinished && win.contentBridgeFixture, "browser and extension startup");
  let g = win.gBrowser, engines = win.ContentEngines;
  let tabs = [];
  for (let n = 0; n < 20; n++) tabs.push(engines.open(base + (n % 2 ? "a" : "b"), false));
  await waitFor(() => tabs.every(tab => tab.linkedBrowser.contentTitle.startsWith("Page") && !tab.hasAttribute("busy")), "twenty loaded WPE tabs");
  check(engines.views.size == 20 && g.tabs.length == 21, "mixed tab counts");
  for (let tab of tabs) { g.selectedTab = tab; engines.layout(); }
  check(g.tabs[0].linkedBrowser.contentDocument.nodeType == 9, "Gecko remains live");
  dump("WPE-STRESS PASS twenty simultaneous WPE tabs and mixed tab switching\n");
  if (Services.prefs.getCharPref("wpe.test.mode") == "shutdown") {
    win.ContentEngineDevTools.open();
    await waitFor(() => inspectors() == 1, "shutdown inspector");
    for (let tab of tabs) engines.get(tab.linkedBrowser).loadURI(base + "slow");
    dump("WPE-STRESS PASS quitting twenty active loads with Inspector and extension\n");
    return;
  }
  let tab = tabs.pop();
  for (let cycle = 0; cycle < 10; cycle++) {
    win.ContentEngineDevTools.open();
    await waitFor(() => inspectors() == 1, "inspector open " + cycle);
    await new Promise(resolve => setTimeout(resolve, 300));
    g.selectedTab = tabs[0]; g.selectedTab = tab;
    win.ContentEngineDevTools.open();
    await waitFor(() => inspectors() == 0, "inspector close " + cycle);
  }
  dump("WPE-STRESS PASS ten Inspector open/close cycles and tab selection\n");
  await win.contentBridgeFixture.run(tab.linkedBrowser);
  win.ContentEngineDevTools.open();
  await waitFor(() => inspectors() == 1, "inspected tab close");
  g.removeTab(tab, {animate:false});
  await waitFor(() => inspectors() == 0 && engines.views.size == 19, "owner destroys inspector");
  tab = tabs.pop(); g.selectedTab = tab;
  win.ContentEngineDevTools.open();
  await waitFor(() => inspectors() == 1, "crash inspector");
  let pending = tab.linkedBrowser.contentAPI.executeScript("await new Promise(() => {});").then(() => false, () => true);
  dump("WPE-STRESS KILL WebProcesses\n");
  await waitFor(() => engines.get(tab.linkedBrowser).native.lastError.includes("terminated"), "process termination notification");
  check(await pending, "pending script not rejected on crash");
  await waitFor(() => inspectors() == 0, "crash closes Inspector");
  let title = tab.linkedBrowser.contentTitle;
  tab.linkedBrowser.reload();
  await waitFor(() => tab.linkedBrowser.contentTitle.startsWith("Page") && tab.linkedBrowser.contentTitle != title &&
    !tab.hasAttribute("busy"), "reload after process termination");
  await win.contentBridgeFixture.run(tab.linkedBrowser);
  dump("WPE-STRESS PASS process termination with Inspector, pending script rejection, reload and extension recovery\n");
  let other = win.OpenBrowserWindow();
  await waitFor(() => other.gBrowser && other.gBrowserInit.delayedStartupFinished, "other window");
  for (let n = 0; n < 10; n++) {
    tab = other.gBrowser.adoptTab(tab, 1, true);
    await waitFor(() => tab.linkedBrowser.contentTitle.startsWith("Page") && !tab.hasAttribute("busy"), "adopt out");
    tab = g.adoptTab(tab, 1, true);
    await waitFor(() => tab.linkedBrowser.contentTitle.startsWith("Page") && !tab.hasAttribute("busy"), "adopt back");
  }
  other.close();
  let detached = g.replaceTabWithWindow(tab);
  await waitFor(() => detached.ContentEngines && detached.ContentEngines.get() &&
    detached.gBrowser.selectedBrowser.contentTitle.startsWith("Page"), "detach");
  detached.ContentEngines.get().loadURI(base + "slow");
  detached.close();
  await waitFor(() => detached.closed, "close window during navigation");
  check(engines.views.size == 18, "adoption leaked native views");
  dump("WPE-STRESS PASS twenty adoptions, detach and close window during navigation\n");
  for (let item of tabs) g.removeTab(item, {animate:false});
  check(engines.views.size == 0 && g.tabs.length == 1, "bulk close leaked views/tabs");
}
