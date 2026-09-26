/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
const Cc = Components.classes, Ci = Components.interfaces, Cr = Components.results;
const cid = Components.ID("{0d597f51-3ae8-4212-bf9e-e89fdc6c0522}");
const contract = "@basilisk-browser.org/content-view;1?engine=mock";
let instances = [];
function bag(values) {
  let result = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
  for (let key of Object.keys(values)) {
    if (typeof values[key] == "number") result.setPropertyAsUint32(key, values[key]);
    else result.setPropertyAsAUTF8String(key, values[key]);
  }
  return result;
}
class MockContentView {
  constructor() {
    this.engineId = "mock"; this.currentURI = "about:blank"; this.title = "";
    this.loading = false; this.focused = false; this.lastError = "";
    this.canGoBack = false; this.canGoForward = false; this.zoom = 1;
    this.muted = false; this.audioPlaying = false;
    this.capabilities = Ci.nsIWebContentView.CAP_CONTENT_SCRIPTS | Ci.nsIWebContentView.CAP_MESSAGING;
    instances.push(this);
  }
  QueryInterface(iid) {
    if (iid.equals(Ci.nsIWebContentView) || iid.equals(Ci.nsISupports)) return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
  attach(host, listener) { this.listener = listener; }
  setBounds(x,y,width,height) { this.bounds = [x,y,width,height]; }
  setVisible(value) { this.visible = value; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  destroy() { this.listener = null; this.destroyed = true; }
  emit(event, data = this) { if (this.listener) this.listener.onContentEvent(this, event, data); }
  loadURI(uri) {
    this.loading = true; this.emit("content-view-state");
    this.currentURI = uri; this.title = "Mock page"; this.loading = false;
    this.emit("content-view-state");
  }
  reload() { this.loadURI(this.currentURI); }
  stop() { this.loading = false; this.emit("content-view-state"); }
  executeScript(id, source) {
    this.emit("content-view-script-result", bag({id, json:'{"simulated":true}', error:""}));
  }
}
const factory = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIFactory]),
  createInstance(outer, iid) {
    if (outer) throw Cr.NS_ERROR_NO_AGGREGATION;
    return new MockContentView().QueryInterface(iid);
  },
  lockFactory() {}
};
function check(value, message) { if (!value) throw new Error(message); }
window.addEventListener("load", () => run().then(() => finish(), finish));
function finish(error) {
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).unregisterFactory(cid, factory);
  dump("CONTENT-MOCK " + (error ? "FAIL " + error + "\n" + error.stack : "PASS lifecycle, capabilities, state and serialized callbacks") + "\n");
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
async function run() {
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(cid, "Test content backend", contract, factory);
  let win = window.openDialog("chrome://browser/content/browser.xul", "_blank", "chrome,all,dialog=no", "about:blank");
  await new Promise(resolve => {
    let observer = subject => {
      if (subject != win) return;
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished"); resolve();
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished", false);
  });
  let tab = win.ContentEngines.open("https://mock.invalid/", true, true, "mock");
  let browser = tab.linkedBrowser, mock = instances[0];
  check(browser.contentEngine == "mock", "hard-coded engine identity");
  check(browser.contentTitle == "Mock page" && browser.currentURI.spec == "https://mock.invalid/", "state bridge failed");
  check(browser.contentDocument === null && browser.contentWindow === null, "foreign DOM fabricated");
  check(browser.contentCapabilities == mock.capabilities, "capability bridge failed");
  check((await browser.contentAPI.executeScript("simulated" )).simulated, "script reply failed");
  let rejected = false;
  try { await browser.contentAPI.insertCSS("body{}"); } catch (error) { rejected = true; }
  check(rejected, "unsupported capability not rejected");
  let received;
  browser.contentAPI.addMessageListener(value => received = value);
  mock.emit("content-view-message", bag({json:'{"mock":true}'}));
  check(received.mock, "message bridge failed");
  mock.lastError = "Simulated process failure"; mock.emit("content-view-process-terminated");
  browser.reload(); check(browser.contentTitle == "Mock page", "reload failed");
  win.gBrowser.removeTab(tab, {animate:false});
  check(mock.destroyed && !mock.listener && win.ContentEngines.views.size == 0, "mock teardown leaked");
}
