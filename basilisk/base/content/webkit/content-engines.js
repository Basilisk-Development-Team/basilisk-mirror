/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// Application-level adapters. Never emulate nsIWebNavigation, Gecko DOM, or
// progress channels for a foreign page. Only external views adapt browser's
// chrome-facing navigation/state properties; Gecko instances are untouched.
var ContentEngines = {
  views: new Map(),
  engineFor(browser) { return this.views.has(browser) ? "webkit" : browser.contentEngine || "gecko"; },
  get(browser = gBrowser.selectedBrowser) { return this.views.get(browser); },
  forBrowser(browser) {
    return this.get(browser) || {
      engineId: "gecko", browser,
      loadURI(uri) { browser.loadURI(uri); },
      reload() { browser.reload(); }, stop() { browser.stop(); },
      goBack() { browser.goBack(); }, goForward() { browser.goForward(); }
    };
  },
  init() {
    ContentEngineSession.init();
    window.controllers.insertControllerAt(0, ContentEngineEditController);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.tabContainer.addEventListener("TabClose", this);
    window.addEventListener("resize", this);
    window.addEventListener("MozAfterPaint", this);
    window.addEventListener("unload", this);
    // GTK content owns native key events. The host sends browser accelerators
    // upward separately; XUL controls are still handled by existing keysets.
  },
  handleEvent(event) {
    if (event.type == "TabClose") {
      let view = this.get(event.target.linkedBrowser);
      if (view) view.destroy();
    } else if (event.type == "unload") {
      window.controllers.removeController(ContentEngineEditController);
      for (let view of Array.from(this.views.values())) view.destroy();
      window.removeEventListener("MozAfterPaint", this);
      window.removeEventListener("resize", this);
    } else {
      this.layout();
      if (event.type == "TabSelect") this.refresh();
    }
  },
  open(uri = "about:blank", selected = true) {
    let tab = gBrowser.addTab("about:blank", {skipAnimation: true});
    try {
      let view = this.attach(tab);
      if (selected) gBrowser.selectedTab = tab;
      view.loadURI(uri);
      this.layout();
      if (selected) view.focus();
      return tab;
    } catch (error) {
      let view = this.get(tab.linkedBrowser);
      if (view) view.destroy();
      gBrowser.removeTab(tab, {animate: false});
      throw error;
    }
  },
  attach(tab) {
    let existing = this.get(tab.linkedBrowser);
    if (existing) return existing;
    let view = new ExternalContentBrowser(tab);
    this.views.set(tab.linkedBrowser, view);
    try { view.attach(); }
    catch (error) { view.destroy(); throw error; }
    return view;
  },
  switchEngine(tab, engine) {
    if (!["gecko", "webkit"].includes(engine)) throw new Error("Unknown content engine");
    if (this.engineFor(tab.linkedBrowser) == engine) {
      tab.linkedBrowser.reload();
      return tab;
    }
    let uri = tab.linkedBrowser.currentURI.spec;
    if (tab.closing || tab._pendingPermitUnload) return tab;
    if (this.engineFor(tab.linkedBrowser) == "gecko") {
      tab._pendingPermitUnload = true;
      let result;
      try { result = tab.linkedBrowser.permitUnload(); }
      finally { delete tab._pendingPermitUnload; }
      if (tab.closing || (!result.timedOut && !result.permitUnload)) return tab;
    }
    // Replace the old content/frame-loader lifetime as a unit. Preserve tab
    // position, selection and pinning, but never transfer live page state.
    let selected = tab == gBrowser.selectedTab;
    let replacement = engine == "webkit" ? this.open(uri, false) :
      gBrowser.addTab(uri, {skipAnimation: true});
    gBrowser.moveTabTo(replacement, tab._tPos);
    if (tab.pinned) gBrowser.pinTab(replacement);
    if (selected) gBrowser.selectedTab = replacement;
    gBrowser.removeTab(tab, {animate: false, skipPermitUnload: true});
    this.layout();
    return replacement;
  },
  layout() {
    for (let [browser, view] of this.views) {
      let active = browser == gBrowser.selectedBrowser && !view.tab.closing &&
                   window.windowState != window.STATE_MINIMIZED;
      let rect = browser.getBoundingClientRect();
      active = active && rect.width > 0 && rect.height > 0;
      if (active) {
        let scale = window.devicePixelRatio;
        let bounds = [rect.left, rect.top, rect.width, rect.height]
                       .map(value => Math.round(value * scale));
        let key = bounds.join(",");
        if (key != view.bounds) {
          view.native.setBounds(...bounds);
          view.bounds = key;
        }
      }
      if (active != view.visible) {
        view.native.setVisible(active);
        view.visible = active;
      }
    }
  },
  refresh() {
    let view = this.get();
    if (!view) return;
    let browser = view.browser;
    URLBarSetURI(browser.currentURI);
    UpdateBackForwardCommands(browser);
    gBrowser.updateTitlebar();
    let loading = view.native.loading;
    gBrowser.mIsBusy = loading;
    XULBrowserWindow.isBusy = loading;
    document.getElementById("Browser:Stop").setAttribute("disabled", !loading);
    if (loading) CombinedStopReload.switchToStop();
    else CombinedStopReload.switchToReload();
    // Do not reuse the empty shell's TLS identity or a preceding Gecko tab's.
    gIdentityHandler.updateIdentity(0, browser.currentURI);
    XULBrowserWindow.setOverLink("", null);
    XULBrowserWindow.setDefaultStatus(view.native.lastError || "");
    for (let id of ["cmd_find", "cmd_findAgain", "cmd_findPrevious"])
      document.getElementById(id).removeAttribute("disabled");
  }
};

class ExternalContentBrowser {
  constructor(tab) {
    this.tab = tab;
    this.browser = tab.linkedBrowser;
    this.engineId = "webkit";
    this.saved = new Map();
    this.visible = false;
    this.bounds = "";
    this.native = Cc["@basilisk-browser.org/web-content-view/wpe;1"]
                    .createInstance(Ci.nsIWebContentView);
    this.principal = Services.scriptSecurityManager.createNullPrincipal({});
    this.finder = new ContentEngineFinder(this);
  }
  define(name, descriptor) {
    this.saved.set(name, Object.getOwnPropertyDescriptor(this.browser, name));
    Object.defineProperty(this.browser, name, Object.assign({configurable: true}, descriptor));
  }
  attach() {
    let b = this.browser;
    b.stop();
    this.filter = gBrowser._tabFilters.get(this.tab);
    b.webProgress.removeProgressListener(this.filter);
    // An inert Gecko frame loader remains for tab/session bookkeeping only.
    // Its DOM must never be exposed as the document rendered by WPE.
    let getters = {
      currentURI: () => Services.io.newURI(this.native.currentURI || "about:blank", null, null),
      documentURI: () => b.currentURI,
      contentTitle: () => this.native.title || this.native.currentURI || "WPE",
      contentDocument: () => null, contentWindow: () => null,
      contentDocumentAsCPOW: () => null, contentWindowAsCPOW: () => null,
      contentPrincipal: () => this.principal,
      securityUI: () => null, documentContentType: () => "text/html",
      isSyntheticDocument: () => false, hasContentOpener: () => false,
      mayEnableCharacterEncodingMenu: () => false,
      canGoBack: () => this.native.canGoBack, canGoForward: () => this.native.canGoForward,
      audioMuted: () => this.native.muted, audioPlaybackStarted: () => this.native.audioPlaying,
      audioBlocked: () => false
    };
    for (let name of Object.keys(getters)) this.define(name, {get: getters[name]});
    this.define("finder", {get: () => this.finder});
    let methods = {
      loadURI: uri => this.loadURI(uri),
      loadURIWithFlags: (uri, flags, referrer, charset, postData) => {
        if (postData || (flags && flags.postData)) throw new Error("WPE chrome POST loading is not supported");
        this.loadURI(uri);
      },
      goBack: () => this.native.goBack(), goForward: () => this.native.goForward(),
      reload: () => this.native.reload(), reloadWithFlags: () => this.native.reload(),
      stop: () => this.native.stop(), focus: () => this.focus(),
      mute: () => { this.native.muted = true; }, unmute: () => { this.native.muted = false; }
    };
    for (let name of Object.keys(methods)) this.define(name, {value: methods[name]});
    this.define("fullZoom", {get: () => this.native.zoom, set: value => { this.native.zoom = value; }});
    this.native.attach(window, this);
    this.tab.setAttribute("contentengine", "webkit");
  }
  QueryInterface(iid) {
    if (iid.equals(Ci.nsIObserver) || iid.equals(Ci.nsISupports)) return this;
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
  observe(subject, topic) {
    if (this.destroyed) return;
    if (topic == "content-view-inspector") {
      window.openDialog("chrome://browser/content/webkit/inspector.xul", "_blank", "chrome,all,dialog=no", subject);
      return;
    }
    if (topic.startsWith("content-view-download-")) {
      ContentEngineDownloads.observe(this, topic, subject.QueryInterface(Ci.nsIWritablePropertyBag2));
      return;
    }
    if (topic.startsWith("content-view-find-")) {
      this.finder.result(topic == "content-view-find-found");
      return;
    }
    if (topic == "content-view-command") {
      let command = subject.QueryInterface(Ci.nsIPropertyBag2).getPropertyAsAUTF8String("command");
      this.native.blur();
      switch (command) {
        case "location": gURLBar.focus(); focusAndSelectUrlBar(); break;
        case "new-tab": BrowserOpenTab(); break;
        case "close-tab": gBrowser.removeCurrentTab(); break;
        case "quit": goQuitApplication(); break;
        case "next-tab": gBrowser.tabContainer.advanceSelectedTab(1, true); break;
        case "previous-tab": gBrowser.tabContainer.advanceSelectedTab(-1, true); break;
        case "find": gFindBar.onFindCommand(); break;
        case "devtools": ContentEngineDevTools.open(this.browser); break;
        case "reload": this.native.reload(); break;
        case "back": this.native.goBack(); break;
        case "forward": this.native.goForward(); break;
        case "zoom-in": FullZoom.enlarge(); break;
        case "zoom-out": FullZoom.reduce(); break;
        case "zoom-reset": FullZoom.reset(); break;
      }
      if (["reload", "back", "forward", "zoom-in", "zoom-out", "zoom-reset"].includes(command)) this.focus();
      return;
    }
    if (topic == "content-view-context-menu") {
      ContentEngineContext.open(this, subject.QueryInterface(Ci.nsIPropertyBag2));
      return;
    }
    if (topic == "content-view-new-window") {
      let info = subject.QueryInterface(Ci.nsIPropertyBag2);
      if (info.getPropertyAsBool("userGesture")) ContentEngines.open(info.getPropertyAsAUTF8String("uri"));
      return;
    }
    if (this.lastURI != this.native.currentURI) {
      this.lastURI = this.native.currentURI;
      this.browser.userTypedValue = null;
    }
    this.tab.label = this.browser.contentTitle;
    for (let [name, value] of [["busy", this.native.loading],
                              ["soundplaying", this.native.audioPlaying], ["muted", this.native.muted]]) {
      if (value) this.tab.setAttribute(name, "true");
      else this.tab.removeAttribute(name);
    }
    gBrowser._tabAttrModified(this.tab, ["label", "busy", "soundplaying", "muted"]);
    ContentEngineSession.save(this);
    if (this.browser == gBrowser.selectedBrowser) ContentEngines.refresh();
  }
  loadURI(uri) {
    this.browser.userTypedValue = null;
    this.requestedURI = uri || "about:blank";
    this.native.loadURI(uri || "about:blank");
    ContentEngineSession.save(this);
  }
  focus() {
    if (!this.destroyed) {
      Services.focus.setFocus(this.browser, Services.focus.FLAG_NOSCROLL);
      this.native.focus();
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.finder.destroy();
    this.native.destroy();
    ContentEngines.views.delete(this.browser);
    for (let [name, descriptor] of this.saved) {
      if (descriptor) Object.defineProperty(this.browser, name, descriptor);
      else delete this.browser[name];
    }
    this.saved.clear();
    // Restore real shell bookkeeping before tabbrowser performs normal close.
    if (this.filter) this.browser.webProgress.addProgressListener(this.filter, Ci.nsIWebProgress.NOTIFY_ALL);
    this.tab.removeAttribute("contentengine");
  }
}

window.addEventListener("load", function() { ContentEngines.init(); });
