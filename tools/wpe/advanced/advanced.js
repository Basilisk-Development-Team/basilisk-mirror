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
        else if (Date.now()-start > 30000) throw new Error("Timeout: " + label);
      } catch (error) { clearInterval(timer); reject(error); }
    }, 100);
  });
}
function check(value, label) { if (!value) throw new Error(label); }
function finish(error) {
  dump("WPE-ADVANCED " + (error ? "FAIL " + error + "\n" + error.stack : "PASS all") + "\n");
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
window.addEventListener("load", () => run().then(() => finish(), finish));
async function run() {
  const base = "http://127.0.0.1:" + Services.prefs.getIntPref("wpe.test.port") + "/";
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", base + "a");
  await waitFor(() => win.gBrowser && win.gBrowserInit.delayedStartupFinished && win.contentBridgeFixture, "extension startup");
  let g = win.gBrowser, engines = win.ContentEngines, fixture = win.contentBridgeFixture;
  await waitFor(() => g.selectedBrowser.contentTitle.startsWith("Page A"), "Gecko loaded");
  let gecko = g.selectedTab, wpe = engines.open(base + "b");
  await waitFor(() => wpe.linkedBrowser.contentTitle.startsWith("Page B") && !engines.get().native.loading, "WPE loaded");
  check(fixture.item.parentNode && fixture.tabs > 0, "Fixture A: XUL UI/tabs");
  for (let tab of [gecko, wpe]) dump("WPE-ADVANCED extension " + JSON.stringify(await fixture.run(tab.linkedBrowser)) + "\n");
  for (let engine of ["gecko", "webkit"])
    check(fixture.states.some(state => state.engine == engine && state.uri.startsWith(base) && state.title.startsWith("Page")), "Fixture B: " + engine + " state");
  let descriptor = Object.getOwnPropertyDescriptor(gecko.linkedBrowser, "permitUnload");
  Object.defineProperty(gecko.linkedBrowser, "permitUnload", {configurable: true,
    value: () => ({timedOut:false, permitUnload:false})});
  try {
    check(engines.switchEngine(gecko, "webkit") === gecko, "cancelled switch replaced tab");
    check(!win.SessionStore.getTabValue(gecko, "basilisk.engineOverride"), "cancelled switch changed override");
  } finally {
    if (descriptor) Object.defineProperty(gecko.linkedBrowser, "permitUnload", descriptor);
    else delete gecko.linkedBrowser.permitUnload;
  }
  let api = wpe.linkedBrowser.contentAPI;
  await api.registerScript("fixture", "document.body.setAttribute('data-persistent', 'yes');");
  await api.insertCSS("body {color: rgb(12, 34, 56) !important;}", "fixture");
  let tab = wpe;
  for (let engine of ["gecko", "webkit", "gecko", "webkit"]) {
    tab = engines.switchEngine(tab, engine);
    await waitFor(() => tab.linkedBrowser.contentTitle.startsWith("Page B") && !tab.hasAttribute("busy"), "switch " + engine);
    check(tab.linkedBrowser.contentAPI === api, "API identity survived switch");
    let value = await api.executeScript("return {registered:document.body.getAttribute('data-persistent'), color:getComputedStyle(document.body).color}");
    check(value.registered == "yes" && value.color == "rgb(12, 34, 56)", "registrations survived " + engine);
    await fixture.run(tab.linkedBrowser);
  }
  await api.unregisterScript("fixture"); await api.removeCSS("fixture");
  tab.linkedBrowser.reload();
  await waitFor(() => !tab.hasAttribute("busy") && tab.linkedBrowser.contentTitle.startsWith("Page B"), "reload");
  check(await api.executeScript("return document.body.getAttribute('data-persistent')") === null, "unregistered script ran");
  dump("WPE-ADVANCED PASS extension fixtures A-F and registrations across switches\n");
  Services.prefs.setCharPref("browser.contentEngine.siteRules", JSON.stringify({"127.0.0.1":"webkit"}));
  check(win.ContentEngineRouting.target(gecko, "http://127.0.0.10/") == "gecko", "host substring matched");
  let rules = {"127.0.0.1":"webkit"}; rules[base.slice(0,-1)] = "gecko";
  Services.prefs.setCharPref("browser.contentEngine.siteRules", JSON.stringify(rules));
  check(win.ContentEngineRouting.target(gecko, base) == "gecko", "origin precedence");
  Services.prefs.setCharPref("browser.contentEngine.siteRules", JSON.stringify({"127.0.0.1":"webkit"}));
  g.selectedTab = g.addTab(base + "a");
  await waitFor(() => engines.get() && g.selectedBrowser.contentTitle.startsWith("Page A"), "automatic Gecko to WPE");
  tab = engines.switchEngine(g.selectedTab, "gecko");
  await waitFor(() => !tab.hasAttribute("busy") && tab.linkedBrowser.contentTitle.startsWith("Page A"), "manual Gecko override");
  check(win.ContentEngineRouting.target(tab, base) == "gecko", "manual precedence");
  win.SessionStore.deleteTabValue(tab, "basilisk.engineOverride");
  tab.linkedBrowser.loadURI(base + "b");
  await waitFor(() => engines.get() && g.selectedBrowser.contentTitle.startsWith("Page B"), "cleared override");
  engines.get().loadURI(base + "redirect-host");
  await waitFor(() => !engines.get() && g.selectedBrowser.currentURI.host == "localhost" &&
    g.selectedBrowser.contentTitle.startsWith("Page B"), "redirect to Gecko host");
  await g.selectedBrowser.contentAPI.executeScript("let f=document.createElement('iframe');f.src=" + JSON.stringify(base + "a") + ";document.body.appendChild(f);");
  await new Promise(resolve => setTimeout(resolve, 1000));
  check(!engines.get() && g.selectedBrowser.currentURI.host == "localhost", "subframe changed engine");
  // Restore saved engine identity even when rules now prefer the other engine.
  let savedGecko = win.SessionStore.getTabState(g.selectedTab);
  Services.prefs.setCharPref("browser.contentEngine.siteRules", JSON.stringify({"localhost":"webkit"}));
  let restored = g.addTab("about:blank"); g.selectedTab = restored;
  win.SessionStore.setTabState(restored, savedGecko);
  await waitFor(() => restored.linkedBrowser.contentTitle.startsWith("Page B") && !restored.hasAttribute("busy"), "explicit Gecko restore");
  check(restored.linkedBrowser.contentEngine == "gecko", "Gecko restore inferred engine from rules");
  restored.linkedBrowser.reload();
  await waitFor(() => engines.get() && g.selectedBrowser.contentTitle.startsWith("Page B"), "routing resumes after restore");
  let savedWPE = win.SessionStore.getTabState(g.selectedTab);
  Services.prefs.setCharPref("browser.contentEngine.siteRules", "{}");
  restored = g.addTab("about:blank"); g.selectedTab = restored;
  win.SessionStore.setTabState(restored, savedWPE);
  await waitFor(() => engines.get(restored.linkedBrowser) && restored.linkedBrowser.contentTitle.startsWith("Page B") &&
    !restored.hasAttribute("busy"), "explicit WPE restore");
  check(restored.linkedBrowser.contentEngine == "webkit", "WPE restore inferred engine from rules");
  Services.prefs.clearUserPref("browser.contentEngine.siteRules");
  dump("WPE-ADVANCED PASS exact-host/origin routing, manual override, redirect and subframe isolation\n");
}
