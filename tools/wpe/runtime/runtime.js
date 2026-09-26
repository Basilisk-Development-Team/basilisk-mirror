/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
function check(value, label) { if (!value) throw new Error(label); }
function waitFor(test, label) {
  return new Promise((resolve, reject) => {
    let start = Date.now(), timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (Date.now()-start > 60000) throw new Error("Timeout: " + label);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 100);
  });
}
window.addEventListener("load", () => run().then(() => finish(), finish));
function finish(error) {
  dump("WPE-RUNTIME " + (error ? "FAIL " + error + "\n" + error.stack : "PASS relocated Gecko, WPE, HTTPS, scripts and Inspector") + "\n");
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
async function run() {
  const uri = "http://127.0.0.1:" + Services.prefs.getIntPref("runtime.test.port") + "/";
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", uri);
  await waitFor(() => win.gBrowserInit && win.gBrowserInit.delayedStartupFinished &&
    win.gBrowser.selectedBrowser.contentTitle == "Relocated content", "Gecko startup");
  const gecko = win.gBrowser.selectedTab;
  const tab = win.ContentEngines.open(uri);
  await waitFor(() => tab.linkedBrowser.contentTitle == "Relocated content" && !tab.hasAttribute("busy"), "WPE content");
  const api = tab.linkedBrowser.contentAPI;
  check(await api.executeScript("return document.querySelector('h1').textContent") == "Relocated content", "real DOM execution");
  await api.insertCSS("body { background: rgb(220, 245, 220) !important; }", "runtime");
  let echoed;
  api.addMessageListener(value => echoed = value);
  await api.executeScript("browserContent.sendMessage({runtime:'relocated'});");
  await waitFor(() => echoed && echoed.runtime == "relocated", "isolated messages");
  win.ContentEngineDevTools.open();
  await waitFor(() => Services.wm.getMostRecentWindow("Basilisk:WebInspector"), "Inspector host");
  // Keep the real upstream frontend visible long enough to inspect/capture it.
  dump("WPE-RUNTIME INSPECTOR OPEN\n");
  await new Promise(resolve => setTimeout(resolve, 5000));
  win.ContentEngineDevTools.open();
  await waitFor(() => !Services.wm.getMostRecentWindow("Basilisk:WebInspector"), "Inspector close");
  tab.linkedBrowser.loadURI("https://example.com/");
  await waitFor(() => tab.linkedBrowser.contentTitle == "Example Domain" && !tab.hasAttribute("busy"), "HTTPS page");
  check(await api.executeScript("return location.protocol") == "https:", "HTTPS origin");
  check(gecko.linkedBrowser.contentDocument.title == "Relocated content", "Gecko changed");
  win.gBrowser.removeTab(tab, {animate:false});
  check(win.ContentEngines.views.size == 0, "view not destroyed");
}
