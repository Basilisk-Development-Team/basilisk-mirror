/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/PlacesUtils.jsm");
function check(value, label) { if (!value) throw Error(label); }
function waitFor(test, label) {
  return new Promise((resolve, reject) => {
    let start = Date.now(), timer = setInterval(() => {
      try {
        if (test()) { clearInterval(timer); resolve(); }
        else if (Date.now() - start > 45000) throw Error(label);
      } catch (e) { clearInterval(timer); reject(e); }
    }, 50);
  });
}
window.addEventListener("load", () => run().then(() => finish(), finish));
function finish(error) {
  dump("NAVIGATION " + (error ? "FAIL " + error + "\n" + error.stack : "PASS all") + "\n");
  Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
async function run() {
  let base = "http://127.0.0.1:" + Services.prefs.getIntPref("navigation.test.port");
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", base + "/initial");
  await waitFor(() => win.gBrowserInit && win.gBrowserInit.delayedStartupFinished, "startup");
  let g = win.gBrowser, serial = 0, alternate = !!win.ContentEngines;
  const engine = () => g.selectedBrowser.contentEngine || "gecko";
  const uri = () => base + "/navigation-" + (++serial);
  async function loaded(url, expected) {
    await waitFor(() => g.selectedBrowser.currentURI.spec == url &&
      g.selectedBrowser.contentTitle == Services.io.newURI(url, null, null).path &&
      !g.selectedTab.hasAttribute("busy"), "load " + url + " current=" + g.selectedBrowser.currentURI.spec);
    if (expected) check(engine() == expected, "wrong engine for " + url);
  }
  async function command(url, expected) {
    win.gURLBar.value = url; win.gURLBar.handleCommand(); await loaded(url, expected);
  }
  Services.search.addEngineWithDetails("Navigation fixture", null, null, null, "GET", base + "/search?q={searchTerms}");
  Services.search.currentEngine = Services.search.getEngineByName("Navigation fixture");
  for (const target of alternate ? ["gecko", "webkit"] : ["gecko"]) {
    if (alternate && engine() != target) {
      win.ContentEngines.switchEngine(g.selectedTab, target);
      await waitFor(() => engine() == target && !g.selectedTab.hasAttribute("busy"), "switch " + target);
    }
    await command(uri(), target);
    let keyboard = uri();
    win.document.title = "Navigation driver";
    dump("NAVIGATION INPUT " + keyboard.replace("http://", "") + "\n");
    await loaded(keyboard, target);
    let pasted = uri();
    Components.classes["@mozilla.org/widget/clipboardhelper;1"].getService(Components.interfaces.nsIClipboardHelper).copyString(pasted);
    win.document.title = "Navigation driver";
    dump("NAVIGATION PASTE " + pasted + "\n");
    await loaded(pasted, target);
    let pasteGo = uri();
    Components.classes["@mozilla.org/widget/clipboardhelper;1"].getService(Components.interfaces.nsIClipboardHelper).copyString(pasteGo);
    // Paste & Go is invoked from the location editor's native context menu.
    // Establish real chrome focus, as clicking that editor does, before using
    // its exact XUL command; focusing an inactive DOM window isn't equivalent.
    dump("NAVIGATION FOCUS " + pasteGo + "\n");
    await waitFor(() => Services.focus.focusedElement == win.gURLBar.inputField, "native location focus");
    win.gURLBar.select();
    win.goDoCommand("cmd_paste"); check(win.gURLBar.value == pasteGo, "Paste & Go missed chrome editor: " + win.gURLBar.value); win.gURLBar.handleCommand();
    await loaded(pasteGo, target);
    win.gURLBar.value = "fixture search"; win.gURLBar.handleCommand();
    await loaded(base + "/search?q=fixture+search", target);
    for (let load of [u => win.openUILink(u, null), u => win.openUILinkIn(u, "current"),
                      u => win.loadURI(u), u => g.loadURI(u),
                      u => g.loadURIWithFlags(u, 0),
                      u => win._loadURIWithFlags(g.selectedBrowser, u, {})]) {
      let url = uri(); load(url); await loaded(url, target);
    }
    let home = uri(); Services.prefs.setCharPref("browser.startup.homepage", home);
    win.BrowserHome(); await loaded(home, target);
    let back = uri(), forward = uri(); await command(back, target); await command(forward, target);
    win.BrowserBack(); await loaded(back, target);
    win.BrowserForward(); await loaded(forward, target);
    win.BrowserReload(); await loaded(forward, target);
    let bookmark = uri();
    let folder = PlacesUtils.bookmarks.createFolder(PlacesUtils.bookmarks.bookmarksMenuFolder, "Navigation fixture", PlacesUtils.bookmarks.DEFAULT_INDEX);
    PlacesUtils.bookmarks.insertBookmark(folder, Services.io.newURI(bookmark, null, null), PlacesUtils.bookmarks.DEFAULT_INDEX, "Fixture");
    let result = PlacesUtils.getFolderContents(folder);
    win.PlacesUIUtils.openNodeIn(result.root.getChild(0), "current", {ownerWindow:win});
    await loaded(bookmark, target); result.root.containerOpen = false;
    let history = uri();
    await new Promise(resolve => PlacesUtils.asyncHistory.updatePlaces({uri:Services.io.newURI(history,null,null),
      visits:[{visitDate:Date.now()*1000,transitionType:PlacesUtils.history.TRANSITION_LINK}]}, {handleCompletion:resolve}));
    let query = PlacesUtils.history.getNewQuery(); query.uri = Services.io.newURI(history,null,null);
    result = PlacesUtils.history.executeQuery(query, PlacesUtils.history.getNewQueryOptions()); result.root.containerOpen = true;
    win.PlacesUIUtils.openNodeIn(result.root.getChild(0), "current", {ownerWindow:win});
    await loaded(history, target); result.root.containerOpen = false;
    let old = g.selectedTab, newTabURL = uri(); win.openUILinkIn(newTabURL, "tab");
    await loaded(newTabURL, "gecko"); g.removeTab(g.selectedTab, {animate:false}); g.selectedTab = old;
    let newWindowURL = uri(); win.openUILinkIn(newWindowURL, "window");
    let other;
    await waitFor(() => (other=Services.wm.getMostRecentWindow("navigator:browser")) != win && other.gBrowserInit &&
      other.gBrowserInit.delayedStartupFinished && other.gBrowser.selectedBrowser.currentURI.spec == newWindowURL, "new window");
    check((other.gBrowser.selectedBrowser.contentEngine || "gecko") == "gecko", "new window default changed"); other.close(); win.focus();
    if (Services.prefs.getBoolPref("navigation.test.https")) {
      win.gURLBar.value = "https://example.com/"; win.gURLBar.handleCommand();
      await waitFor(() => g.selectedBrowser.currentURI.spec == "https://example.com/" && g.selectedBrowser.contentTitle == "Example Domain", "HTTPS " + target);
      check(engine() == target, "HTTPS changed manual engine");
    }
    dump("NAVIGATION PASS chrome entry points " + target + "\n");
  }
  if (!alternate) return;
  const cycles = Services.prefs.getIntPref("navigation.test.cycles");
  for (let i = 0; i < cycles; ++i) {
    win.ContentEngines.switchEngine(g.selectedTab, "gecko"); await command(uri(), "gecko");
    win.ContentEngines.switchEngine(g.selectedTab, "webkit"); await command(uri(), "webkit");
    win.ContentEngines.switchEngine(g.selectedTab, "gecko"); await command(uri(), "gecko");
  }
  dump("NAVIGATION PASS " + cycles + " switches with address-bar loads\n");
  Services.prefs.setCharPref("browser.contentEngine.siteRules", JSON.stringify({"127.0.0.1":"webkit", "localhost":"gecko"}));
  // An explicit tab choice outranks the matching site rule.
  await command(uri(), "gecko");
  win.SessionStore.deleteTabValue(g.selectedTab, "basilisk.engineOverride");
  const fixed = base + "/routing", geckoURL = fixed.replace("127.0.0.1", "localhost");
  for (let i = 0; i < 4; ++i) {
    await command(geckoURL, "gecko"); await command(fixed, "webkit");
    await command(fixed + "?same", "webkit"); await command(geckoURL, "gecko");
    check(!g.selectedTab.hasAttribute("contentroutingblocked"), "new chrome navigation inherited a redirect loop");
  }
  await command(fixed, "webkit");
  // Supersede a route queued from the old selected view before its timeout runs.
  win.openUILinkIn(geckoURL, "current"); win.openUILinkIn(fixed + "?newest", "current");
  await loaded(fixed + "?newest", "webkit");
  await new Promise(resolve => setTimeout(resolve, 300));
  check(g.selectedBrowser.currentURI.spec == fixed + "?newest", "stale route won");
  dump("NAVIGATION PASS routing, manual precedence and stale route cancellation\n");
}
