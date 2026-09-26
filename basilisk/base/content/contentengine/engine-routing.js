/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentEngineRouting = {
  init() {
    this.progress = {onLocationChange: (browser, progress, request, uri) => {
      if (!progress.isTopLevel || ContentEngines.get(browser) || !request) return;
      try {
        if (request.QueryInterface(Ci.nsIHttpChannel).requestMethod == "GET")
          this.route(gBrowser.getTabForBrowser(browser), uri.spec);
      } catch (error) { /* Non-HTTP Gecko navigation is never routed. */ }
    }};
    gBrowser.addTabsProgressListener(this.progress);
    window.addEventListener("unload", () => gBrowser.removeTabsProgressListener(this.progress));
  },
  preference(name, fallback) {
    try { return Services.prefs.getCharPref("browser.contentEngine." + name); }
    catch (error) { return fallback; }
  },
  target(tab, spec) {
    let uri;
    try { uri = Services.io.newURI(spec, null, null); }
    catch (error) { return null; }
    if (!uri.schemeIs("http") && !uri.schemeIs("https")) return null;
    let override = SessionStore.getTabValue(tab, "basilisk.engineOverride");
    if (override == "gecko" || (override &&
        "@basilisk-browser.org/content-view;1?engine=" + override in Cc)) return override;
    let text = this.preference("siteRules", "{}");
    if (text != this.rulesText) {
      this.rulesText = text;
      this.hosts = new Map(); this.origins = new Map();
      try {
        let rules = JSON.parse(text);
        if (!rules || Array.isArray(rules) || typeof rules != "object") throw new Error("Expected a rules object");
        for (let key of Object.keys(rules)) {
          let engine = rules[key];
          if (!["default", "gecko", "webkit"].includes(engine)) throw new Error("Invalid engine in site rules");
          let origin = key.includes("://");
          let parsed = Services.io.newURI(origin ? key : "http://" + key, null, null);
          if ((!parsed.schemeIs("http") && !parsed.schemeIs("https")) || parsed.userPass || parsed.path != "/" ||
              (!origin && (key.includes(":") || key.includes("/"))))
            throw new Error("Expected exact host or HTTP(S) origin in site rules");
          (origin ? this.origins : this.hosts).set(origin ? parsed.prePath : parsed.asciiHost, engine);
        }
      } catch (error) {
        this.hosts.clear(); this.origins.clear(); Cu.reportError(error);
      }
    }
    let engine = this.origins.get(uri.prePath) || this.hosts.get(uri.asciiHost) || "default";
    if (engine == "default") engine = this.preference("default", "gecko");
    return engine == "webkit" ? "webkit" : "gecko";
  },
  route(tab, uri) {
    if (!tab || tab.closing || tab._contentRestoring || tab._contentRoutePending) return false;
    // Restoration uses the explicitly saved engine, even after rules change.
    if (tab._contentRestoreURI == uri) { delete tab._contentRestoreURI; return false; }
    let engine = this.target(tab, uri);
    if (!engine || engine == ContentEngines.engineFor(tab.linkedBrowser)) return false;
    let now = Date.now();
    let chain = (tab._contentRouteChain || []).filter(entry => now - entry.time < 10000);
    if (chain.length >= 6 || chain.some(entry => entry.uri == uri && entry.engine == engine)) {
      tab.setAttribute("contentroutingblocked", "true");
      return false; // Stop cross-engine redirects without issuing another load.
    }
    chain.push({uri, engine, time: now});
    tab._contentRoutePending = true;
    // Never tear down a WebKit view from inside its policy signal callback.
    setTimeout(() => {
      delete tab._contentRoutePending;
      if (tab.closing || !tab.parentNode) return;
      try {
        let replacement = ContentEngines.switchEngine(tab, engine, {manual: false, uri});
        replacement._contentRouteChain = chain;
      } catch (error) { Cu.reportError(error); }
    }, 0);
    return true;
  }
};
