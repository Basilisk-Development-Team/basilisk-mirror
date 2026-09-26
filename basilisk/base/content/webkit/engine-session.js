/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// SessionStore owns ordering, selection, pinning and window/private policy.
// Its extData carries external content, never synthetic Gecko history entries.
var ContentEngineSession = {
  init() {
    for (let tab of gBrowser.tabs) this.identify(tab);
    gBrowser.tabContainer.addEventListener("TabOpen", event => this.identify(event.target));
    gBrowser.tabContainer.addEventListener("SSTabRestoring", event => {
      let tab = event.target;
      tab._contentRestoring = true;
      tab._contentRestoreURI = this.engine(tab) == "webkit" ?
        SessionStore.getTabValue(tab, "basilisk.contentURI") : tab.linkedBrowser.currentURI.spec;
      if (this.engine(tab) == "webkit")
        tab.label = SessionStore.getTabValue(tab, "basilisk.contentTitle") ||
                    SessionStore.getTabValue(tab, "basilisk.contentURI") || "WPE";
    });
    gBrowser.tabContainer.addEventListener("SSTabRestored", event => this.restore(event.target));
  },
  engine(tab) { return SessionStore.getTabValue(tab, "basilisk.contentEngine") || "gecko"; },
  identify(tab) {
    let browser = tab.linkedBrowser;
    if (!Object.getOwnPropertyDescriptor(browser, "contentAPI"))
      Object.defineProperty(browser, "contentAPI", {get: () => ContentEngineScripts.forBrowser(browser)});
    if (!Object.getOwnPropertyDescriptor(browser, "contentEngine"))
      Object.defineProperty(browser, "contentEngine", {get: () =>
        ContentEngines.get(browser) ? "webkit" : this.engine(tab)});
    if (!SessionStore.getTabValue(tab, "basilisk.contentEngine"))
      SessionStore.setTabValue(tab, "basilisk.contentEngine", "gecko");
  },
  save(view) {
    let state = {
      contentEngine: "webkit",
      contentURI: view.native.currentURI || view.requestedURI || "about:blank",
      contentTitle: view.native.title || "",
      contentZoom: String(view.native.zoom),
      contentMuted: String(view.native.muted)
    };
    for (let name of Object.keys(state)) {
      let key = "basilisk." + name;
      if (SessionStore.getTabValue(view.tab, key) != state[name])
        SessionStore.setTabValue(view.tab, key, state[name]);
    }
  },
  restore(tab) {
    delete tab._contentRestoring;
    if (tab.closing || this.engine(tab) != "webkit") return;
    let uri = SessionStore.getTabValue(tab, "basilisk.contentURI") || "about:blank";
    let zoom = Number(SessionStore.getTabValue(tab, "basilisk.contentZoom")) || 1;
    let muted = SessionStore.getTabValue(tab, "basilisk.contentMuted") == "true";
    try {
      let view = ContentEngines.attach(tab);
      view.native.zoom = Math.max(0.1, Math.min(10, zoom));
      view.native.muted = muted;
      view.loadURI(uri);
      ContentEngines.layout();
      if (tab == gBrowser.selectedTab) ContentEngines.refresh();
    } catch (error) {
      // Keep the engine marker so a failed external restore never silently
      // loads the user's authenticated WPE URI in Gecko instead.
      Cu.reportError(error);
      tab.label = "WPE restore failed";
    }
  }
};
