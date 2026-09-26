/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
const Ci = Components.interfaces;
function check(value, label) { if (!value) throw new Error(label); }
function waitFor(test, label) {
  return new Promise((resolve, reject) => {
    let start = Date.now(), timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (Date.now() - start > 30000) throw new Error("Timeout: " + label);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 50);
  });
}
async function rejects(promise, label) {
  let rejected = false;
  try { await promise; } catch (error) { rejected = true; }
  check(rejected, label);
}
async function openWindow() {
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", "about:blank");
  await waitFor(() => win.gBrowserInit && win.gBrowserInit.delayedStartupFinished, "startup");
  return win;
}
window.addEventListener("load", () => run().then(() => finish(), finish));
function finish(error) {
  dump("CONTENT-FILTER " + (error ? "FAIL " + error + "\n" + error.stack : "PASS all") + "\n");
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
async function run() {
  const base = "http://127.0.0.1:" + Services.prefs.getIntPref("content.test.port");
  let win = await openWindow(), other = await openWindow();
  let tab = win.ContentEngines.open("about:blank"), serial = 0;
  const rules = [{urlPrefix:base + "/blocked", resourceTypes:["script", "fetch"]}];
  async function loaded(tab, blocked) {
    await waitFor(() => tab.linkedBrowser.contentTitle == "Ready" && !tab.hasAttribute("busy"), "page load");
    let value = await tab.linkedBrowser.contentAPI.executeScript("return {blocked:document.body.dataset.blocked, allowed:document.body.dataset.allowed, fetch:document.body.dataset.fetch}");
    check(value.allowed == "yes", "allowed request failed");
    check(value.blocked == (blocked ? undefined : "yes"), "script policy: " + JSON.stringify(value));
    check(value.fetch == (blocked ? "blocked" : "loaded"), "fetch policy: " + JSON.stringify(value));
  }
  async function load(tab, blocked) {
    tab.linkedBrowser.loadURI(base + "/page?" + (++serial));
    await loaded(tab, blocked);
  }
  let api = tab.linkedBrowser.contentAPI;
  let privateWin = win.OpenBrowserWindow({private:true});
  await waitFor(() => privateWin.gBrowserInit && privateWin.gBrowserInit.delayedStartupFinished, "private startup");
  let privateTab = privateWin.ContentEngines.open("about:blank");
  check(!(privateTab.linkedBrowser.contentAPI.capabilities & Ci.nsIWebContentView.CAP_REQUEST_FILTERING), "private policy store exposed");
  await rejects(privateTab.linkedBrowser.contentAPI.setRequestRules("private", rules), "private policy accepted");
  privateWin.close();
  await rejects(win.gBrowser.tabs[0].linkedBrowser.contentAPI.setRequestRules("gecko", rules), "foreign policy accepted by Gecko");
  check(api.capabilities & Ci.nsIWebContentView.CAP_REQUEST_FILTERING, "missing capability");
  await api.setRequestRules("test", rules);
  await load(tab, true);
  let unfiltered = win.ContentEngines.open("about:blank");
  await load(unfiltered, false);
  await rejects(api.setRequestRules("bad", [{urlPrefix:base, requestingOrigin:base}]), "origin silently accepted");
  await rejects(api.setRequestRules("bad", [{urlPrefix:base, resourceTypes:["unknown"]}]), "unknown type accepted");
  await api.setRequestRules("test", [{urlPrefix:base + "/never", resourceTypes:["script"]}]);
  await load(tab, false);
  await api.setRequestRules("test", rules);
  await api.removeRequestRules("test");
  await load(tab, false);
  let superseded = api.setRequestRules("race", rules);
  await api.removeRequestRules("race");
  await rejects(superseded, "removed pending policy installed");
  await load(tab, false);
  await api.setRequestRules("test", rules);
  await api.registerScript("state", "document.body.dataset.registration='yes';");
  await api.insertCSS("body {color:rgb(1, 2, 3) !important}", "state");
  const cycles = Services.prefs.getIntPref("content.test.cycles");
  for (let i = 0; i < cycles; ++i) {
    tab = win.ContentEngines.switchEngine(tab, "gecko");
    await loaded(tab, false); // Foreign policies never replace Gecko content policy.
    tab = win.ContentEngines.switchEngine(tab, "webkit");
    await loaded(tab, true);
    check(await tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.registration") == "yes", "script lost on switch");
  }
  dump("CONTENT-FILTER PASS " + cycles + " filtered switching cycles\n");
  for (let i = 0; i < 10; ++i) {
    tab = other.gBrowser.adoptTab(tab, 1, true); await loaded(tab, true);
    tab = win.gBrowser.adoptTab(tab, 1, true); await loaded(tab, true);
    let value = await tab.linkedBrowser.contentAPI.executeScript("return {script:document.body.dataset.registration, color:getComputedStyle(document.body).color}");
    check(value.script == "yes" && value.color == "rgb(1, 2, 3)", "adoption lost registrations");
  }
  dump("CONTENT-FILTER PASS twenty filtered adoptions\n");
  let closing = win.ContentEngines.open("about:blank");
  let pending = closing.linkedBrowser.contentAPI.setRequestRules("pending", rules);
  win.gBrowser.removeTab(closing, {animate:false});
  await rejects(pending, "closed policy not rejected");
  await new Promise(resolve => setTimeout(resolve, 500));
}
