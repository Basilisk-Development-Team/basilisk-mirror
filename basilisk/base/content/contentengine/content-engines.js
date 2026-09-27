/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// Application-level adapters. Never emulate nsIWebNavigation, Gecko DOM, or
// progress channels for a foreign page. Only external views adapt browser's
// chrome-facing navigation/state properties; Gecko instances are untouched.
var ContentEngines = {
  views: new Map(),
  engineFor(browser) { return this.views.has(browser) ? this.views.get(browser).engineId : browser.contentEngine || "gecko"; },
  get(browser = gBrowser.selectedBrowser) { return this.views.get(browser); },
  // Chrome supplies user input and nsIWebNavigation fixup flags, whereas the
  // content-view contract accepts a resolved URI. Keep UXP's fixup service at
  // this boundary; alternate engines must not load the bookkeeping docshell.
  navigate(browser, input, params = {}) {
    // A new chrome navigation is not another hop in the preceding redirect
    // chain. Also invalidate a queued route for an older user request.
    let tab = gBrowser.getTabForBrowser(browser);
    if (tab) {
      delete tab._contentRouteChain;
      delete tab._contentRoutePending;
      delete tab._contentPendingLoad;
      tab.removeAttribute("contentroutingblocked");
    }
    let view = this.get(browser);
    if (!view) return false; // Preserve the ordinary Gecko navigation path.
    let text = String(input || "about:blank").replace(/[\r\n]/g, "").trim();
    let flags = params.flags || 0, fixupFlags = 0;
    try { Services.io.newURI(text, null, null); flags &= ~Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP; }
    catch (error) { /* The fixup service resolves host names and search terms. */ }
    if (flags & Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP)
      fixupFlags |= Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP;
    if (flags & Ci.nsIWebNavigation.LOAD_FLAGS_FIXUP_SCHEME_TYPOS)
      fixupFlags |= Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
    let post = {}, info = Services.uriFixup.getFixupURIInfo(text, fixupFlags, post);
    if (params.postData || post.value)
      throw Components.Exception("Alternate content does not support chrome POST navigation", Cr.NS_ERROR_NOT_IMPLEMENTED);
    let uri = info.preferredURI.spec;
    if (!ContentEngineRouting.route(view.tab, uri)) view.loadURI(uri);
    return true;
  },
  forBrowser(browser) {
    return this.get(browser) || {
      engineId: "gecko", browser,
      loadURI(uri) { browser.loadURI(uri); },
      reload() { browser.reload(); }, stop() { browser.stop(); },
      goBack() { browser.goBack(); }, goForward() { browser.goForward(); }
    };
  },
  capabilitiesFor(browser) {
    let view = this.get(browser);
    if (view) return view.native.capabilities;
    if (this.engineFor(browser) != "gecko") return 0;
    let c = Ci.nsIWebContentView;
    return c.CAP_DEVTOOLS | c.CAP_INSPECT_ELEMENT | c.CAP_FULLSCREEN | c.CAP_DOWNLOADS |
      c.CAP_CONTENT_SCRIPTS | c.CAP_ISOLATED_CONTENT_WORLD | c.CAP_PRIVATE_STORAGE |
      c.CAP_AUDIO_CONTROL | c.CAP_CSS | c.CAP_SCRIPT_REGISTRATION | c.CAP_MESSAGING | c.CAP_FIND | c.CAP_FRAMES | c.CAP_SCRIPT_TIMING |
      (PrivateBrowsingUtils.isBrowserPrivate(browser) ? 0 : c.CAP_PERSISTENT_STORAGE);
  },
  supports(browser, capability) { return !!(this.capabilitiesFor(browser) & capability); },
  createView(engine) {
    return Cc["@basilisk-browser.org/content-view;1?engine=" + engine].createInstance(Ci.nsIWebContentView);
  },
  init() {
    ContentEngineSession.init();
    ContentEngineEvents.init();
    ContentEngineRouting.init();
    ContentEngineBlocking.init();
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
    if (ContentEngineFullscreen.view &&
        (event.type == "TabSelect" || event.type == "TabClose" || event.type == "unload"))
      ContentEngineFullscreen.exit();
    if (event.type == "TabClose") {
      ContentEngineScripts.close(event.target.linkedBrowser);
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
  open(uri = "about:blank", selected = true, manual = true, engine = "webkit") {
    let tab = gBrowser.addTab("about:blank", {skipAnimation: true});
    try {
      if (manual) SessionStore.setTabValue(tab, "basilisk.engineOverride", engine);
      let view = this.attach(tab, engine);
      if (selected) gBrowser.selectedTab = tab;
      this.loadWhenReady(view, uri);
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
  attach(tab, engine = "webkit") {
    let existing = this.get(tab.linkedBrowser);
    if (existing) return existing;
    let view = new ExternalContentBrowser(tab, engine);
    this.views.set(tab.linkedBrowser, view);
    try { view.attach(); }
    catch (error) { view.destroy(); throw error; }
    view.ready = ContentEngineScripts.transfer(tab.linkedBrowser, tab.linkedBrowser);
    return view;
  },
  loadWhenReady(view, uri) {
    if (!view.ready) { view.loadURI(uri); return; }
    view.pendingURI = uri;
    ContentEngineSession.save(view);
    Promise.resolve(view.ready).then(() => {
      if (view.destroyed || view.pendingURI !== uri) return;
      delete view.pendingURI;
      delete view.ready;
      view.loadURI(uri);
    }, error => {
      Cu.reportError(error);
      if (!view.destroyed) view.tab.label = "Content setup failed";
    });
  },
  switchEngine(tab, engine, options = {}) {
    if (engine != "gecko" && !("@basilisk-browser.org/content-view;1?engine=" + engine in Cc)) throw new Error("Unknown content engine");
    let manual = options.manual !== false;
    if (this.engineFor(tab.linkedBrowser) == engine) {
      if (manual) {
        SessionStore.setTabValue(tab, "basilisk.engineOverride", engine);
        delete tab._contentRouteChain;
        tab.removeAttribute("contentroutingblocked");
      }
      tab.linkedBrowser.reload();
      return tab;
    }
    let uri = options.uri || tab.linkedBrowser.currentURI.spec;
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
    let replacement = engine != "gecko" ? this.open("about:blank", false, false, engine) :
      gBrowser.addTab("about:blank", {skipAnimation: true});
    let override = manual ? engine : SessionStore.getTabValue(tab, "basilisk.engineOverride");
    if (override) SessionStore.setTabValue(replacement, "basilisk.engineOverride", override);
    gBrowser.moveTabTo(replacement, tab._tPos);
    if (tab.pinned) gBrowser.pinTab(replacement);
    if (selected) gBrowser.selectedTab = replacement;
    let ready = ContentEngineScripts.transfer(tab.linkedBrowser, replacement.linkedBrowser);
    let view = this.get(replacement.linkedBrowser);
    if (view) {
      view.ready = ready;
      this.loadWhenReady(view, uri);
    } else {
      let pending = {};
      replacement._contentPendingLoad = pending;
      Promise.resolve(ready).then(() => {
        if (!replacement.closing && replacement._contentPendingLoad === pending) {
          delete replacement._contentPendingLoad;
          replacement.linkedBrowser.loadURI(uri);
        }
      }, error => {
        Cu.reportError(error);
        if (!replacement.closing) replacement.label = "Content setup failed";
      });
    }
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
  constructor(tab, engine) {
    this.tab = tab;
    this.browser = tab.linkedBrowser;
    this.engineId = engine;
    this.saved = new Map();
    this.visible = false;
    this.bounds = "";
    this.native = ContentEngines.createView(engine);
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
    // Its DOM must never be exposed as the document rendered by alternate content.
    let getters = {
      currentURI: () => Services.io.newURI(this.native.currentURI || "about:blank", null, null),
      documentURI: () => b.currentURI,
      contentTitle: () => this.native.title || this.native.currentURI || "alternate content",
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
      loadURI: uri => ContentEngines.navigate(b, uri),
      loadURIWithFlags: (uri, flags, referrer, charset, postData) => {
        ContentEngines.navigate(b, uri, flags && typeof flags == "object" ? flags :
          {flags, referrerURI: referrer, charset, postData});
      },
      goBack: () => this.native.goBack(), goForward: () => this.native.goForward(),
      reload: () => this.native.reload(), reloadWithFlags: () => this.native.reload(),
      // UXP's default methods QI the Gecko navigation object for a load group.
      // Alternate network scheduling is backend-owned and has no such object.
      adjustPriority: () => {}, setPriority: () => {},
      stop: () => { delete this.pendingURI; this.preparingNavigation=null; this.tab.removeAttribute("busy"); this.native.stop(); }, focus: () => this.focus(),
      mute: () => { this.native.muted = true; }, unmute: () => { this.native.muted = false; }
    };
    methods.reload = () => ContentEngineBlocking.prepare(this,this.native.currentURI || "about:blank").then(() => {
      if (!this.destroyed) this.native.reload();
    }).catch(Cu.reportError);
    methods.reloadWithFlags = methods.reload;
    for (let name of Object.keys(methods)) this.define(name, {value: methods[name]});
    // Browser-facing navigation operations, with no docshell/QI/DOM claims.
    // Legacy chrome commonly reaches reload through this property.
    const navigation = Object.freeze({
      QueryInterface: () => {throw Components.Exception("No Gecko navigation interface",Cr.NS_ERROR_NO_INTERFACE);},
      reload:methods.reload, stop:methods.stop, goBack:methods.goBack, goForward:methods.goForward,
      loadURI:(uri,flags,referrer,postData,headers) => {
        if (headers) throw Components.Exception("Alternate request headers unsupported",Cr.NS_ERROR_NOT_IMPLEMENTED);
        ContentEngines.navigate(b,uri,{flags,referrerURI:referrer,postData});
      },
      get currentURI() {return b.currentURI;},
      get canGoBack() {return b.canGoBack;}, get canGoForward() {return b.canGoForward;}
    });
    this.define("webNavigation",{get:()=>navigation});
    this.define("fullZoom", {get: () => this.native.zoom, set: value => { this.native.zoom = value; }});
    this.native.attach(window, this);
    this.tab.setAttribute("contentengine", this.engineId);
  }
  QueryInterface(iid) {
    if (iid.equals(Ci.nsIContentViewObserver) || iid.equals(Ci.nsISupports)) return this;
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
  onContentEvent(sender, topic, subject) {
    if (this.destroyed) return;
    if (topic == "content-view-permission-denied") {
      let info = subject.QueryInterface(Ci.nsIPropertyBag2);
      this.browser.dispatchEvent(new CustomEvent("ContentPermissionDenied", {bubbles: true,
        detail: Object.freeze({engine: this.engineId, permission: info.getPropertyAsAUTF8String("permission"),
          reason: info.getPropertyAsAUTF8String("reason"), requestingOrigin: null, topLevelOrigin: null})}));
      return;
    }
    if (topic == "content-view-process-terminated") {
      this.browser.dispatchEvent(new CustomEvent("ContentEngineProcessTerminated", {bubbles:true}));
      if (ContentEngineFullscreen.view == this) ContentEngineFullscreen.exit();
      let client = ContentEngineScripts.clients.get(this.browser);
      if (client) for (let id of Array.from(client.pending.keys()))
        client.result(id, "null", "WebKit content process terminated");
    }
    if (topic == "content-view-navigation-prepare") {
      const info=subject.QueryInterface(Ci.nsIWritablePropertyBag2);
      const id=info.getPropertyAsUint32("id");
      info.setPropertyAsBool("deferred",true);
      ContentEngineBlocking.prepare(this,info.getPropertyAsAUTF8String("uri")).then(() => {
        if (!this.destroyed) this.native.completeNavigationPreparation(id,true);
      }, error => {
        Cu.reportError(error);
        if (!this.destroyed) this.native.completeNavigationPreparation(id,false);
      }).catch(Cu.reportError);
      return;
    }
    if (topic == "content-view-route") {
      let info = subject.QueryInterface(Ci.nsIWritablePropertyBag2);
      info.setPropertyAsBool("handled", ContentEngineRouting.route(this.tab, info.getPropertyAsAUTF8String("uri")));
      return;
    }
    if (topic == "content-view-message") {
      let info = subject.QueryInterface(Ci.nsIPropertyBag2), frame;
      if (info.hasKey("frameId")) frame = Object.freeze({frameId:info.getPropertyAsAUTF8String("frameId"),
        documentURI:info.getPropertyAsAUTF8String("documentURI"), isTopFrame:info.getPropertyAsBool("isTopFrame")});
      ContentEngineScripts.message(this.browser, info.getPropertyAsAUTF8String("json"), frame);
      return;
    }
    if (topic == "content-view-script-result" || topic == "content-view-policy-result") {
      ContentEngineScripts.result(this.browser, subject.QueryInterface(Ci.nsIPropertyBag2));
      return;
    }
    if (topic == "content-view-inspector") {
      window.openDialog("chrome://browser/content/contentengine/inspector.xul", "_blank", "chrome,all,dialog=no", subject);
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
        case "fullscreen-enter": ContentEngineFullscreen.enter(this); break;
        case "fullscreen-exit": ContentEngineFullscreen.exit(); break;
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
    for (let [name, value] of [["busy", this.native.loading || !!this.preparingNavigation],
                              ["soundplaying", this.native.audioPlaying], ["muted", this.native.muted]]) {
      if (value) this.tab.setAttribute(name, "true");
      else this.tab.removeAttribute(name);
    }
    gBrowser._tabAttrModified(this.tab, ["label", "busy", "soundplaying", "muted"]);
    ContentEngineSession.save(this);
    ContentEngineBlocking.updatePage(this.browser);
    if (this.browser == gBrowser.selectedBrowser) ContentEngines.refresh();
  }
  loadURI(uri) {
    if (this.ready) { ContentEngines.loadWhenReady(this, uri); return; }
    this.browser.userTypedValue = null;
    this.requestedURI = uri || "about:blank";
    const request=this.requestedURI, ticket={};
    this.preparingNavigation=ticket;
    this.tab.setAttribute("busy","true");
    ContentEngineBlocking.prepare(this,request).then(() => {
      if (!this.destroyed && this.preparingNavigation===ticket) {
        this.native.loadURI(request);
        this.preparingNavigation=null;
      }
    }).catch(error => {
      Cu.reportError(error);
      if (!this.destroyed && this.preparingNavigation===ticket) {
        this.preparingNavigation=null;
        this.tab.removeAttribute("busy");
        this.tab.label="Content policy setup failed";
      }
    });
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
    if (ContentEngineFullscreen.view == this) ContentEngineFullscreen.exit();
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
