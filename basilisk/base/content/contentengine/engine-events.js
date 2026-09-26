/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Browser state, not a synthetic event from a foreign content Document.
var ContentEngineEvents = {
  previous: new WeakMap(),
  init() {
    this.progress = {
      onLocationChange: (browser, progress) => { if (progress.isTopLevel) this.emit(browser); },
      onStateChange: (browser, progress) => { if (progress.isTopLevel) this.emit(browser); }
    };
    this.attributes = event => this.emit(event.target.linkedBrowser);
    gBrowser.addTabsProgressListener(this.progress);
    gBrowser.tabContainer.addEventListener("TabAttrModified", this.attributes);
    window.addEventListener("unload", () => {
      gBrowser.removeTabsProgressListener(this.progress);
      gBrowser.tabContainer.removeEventListener("TabAttrModified", this.attributes);
    });
  },
  emit(browser) {
    if (!browser) return;
    let tab = gBrowser.getTabForBrowser(browser);
    if (!tab || tab.closing) return;
    let view = ContentEngines.get(browser);
    let state = {
      engine: browser.contentEngine, uri: browser.currentURI.spec,
      title: browser.contentTitle || "", loading: view ? view.native.loading : browser.webProgress.isLoadingDocument,
      canGoBack: browser.canGoBack, canGoForward: browser.canGoForward,
      muted: tab.hasAttribute("muted"), audioPlaying: tab.hasAttribute("soundplaying")
    };
    if (view) {
      state.cameraActive = view.native.cameraActive;
      state.microphoneActive = view.native.microphoneActive;
      state.screenCaptureActive = view.native.screenCaptureActive;
    }
    let serialized = JSON.stringify(state);
    if (this.previous.get(browser) == serialized) return;
    this.previous.set(browser, serialized);
    browser.dispatchEvent(new CustomEvent("ContentEngineState", {bubbles: true, detail: Object.freeze(state)}));
  }
};
