/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
var {utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");
const windows = new Map();
function attach(win) {
  if (windows.has(win)) return;
  let item = win.document.createElement("menuitem");
  item.id = "content-bridge-fixture";
  item.setAttribute("label", "Content bridge fixture");
  win.document.getElementById("menu_ToolsPopup").appendChild(item);
  let fixture = {tabs: 0, states: [], item};
  fixture.run = async browser => {
    let api = browser.contentAPI;
    let engine = browser.contentEngine;
    let original = await api.executeScript("return getComputedStyle(document.body).backgroundColor");
    let token = await api.insertCSS("body {background-color: rgb(3, 7, 11) !important;}");
    if (await api.executeScript("return getComputedStyle(document.body).backgroundColor") != "rgb(3, 7, 11)")
      throw new Error(engine + " CSS insertion failed");
    await api.removeCSS(token);
    if (await api.executeScript("return getComputedStyle(document.body).backgroundColor") != original)
      throw new Error(engine + " CSS removal failed");
    let value = await api.executeScript("await Promise.resolve(); document.body.setAttribute('data-extension', 'real DOM'); return {value: document.body.getAttribute('data-extension'), components: typeof Components};");
    if (value.value != "real DOM" || value.components != "undefined") throw new Error(engine + " script isolation failed: " + JSON.stringify(value));
    let reply = new Promise((resolve, reject) => {
      let timer = win.setTimeout(() => reject(new Error("Message timeout")), 5000);
      let listener = message => {
        if (message.fixture != 42) return;
        win.clearTimeout(timer); api.removeMessageListener(listener); resolve(message);
      };
      api.addMessageListener(listener);
    });
    await api.executeScript("browserContent.addMessageListener(value => browserContent.sendMessage({fixture:value.fixture, title:document.title}));");
    await api.sendMessage({fixture:42});
    await reply;
    if (engine == "webkit") {
      if (browser.contentDocument !== null || browser.contentWindow !== null) throw new Error("Foreign DOM exposed");
    } else if (browser.contentDocument.nodeType != 9 || !browser.contentWindow)
      throw new Error("Gecko DOM regressed");
    return {engine, css:true, script:true, messages:true, DOM:engine == "gecko" ? "native" : "unsupported"};
  };
  fixture.open = () => fixture.tabs++;
  fixture.state = event => fixture.states.push(event.detail);
  win.gBrowser.tabContainer.addEventListener("TabOpen", fixture.open);
  win.gBrowser.addEventListener("ContentEngineState", fixture.state);
  win.contentBridgeFixture = fixture;
  windows.set(win, fixture);
}
function observe(win) { attach(win); }
function startup() {
  Services.obs.addObserver(observe, "browser-delayed-startup-finished", false);
  let all = Services.wm.getEnumerator("navigator:browser");
  while (all.hasMoreElements()) attach(all.getNext());
}
function shutdown() {
  Services.obs.removeObserver(observe, "browser-delayed-startup-finished");
  for (let [win, fixture] of windows) {
    if (win.closed) continue;
    win.gBrowser.tabContainer.removeEventListener("TabOpen", fixture.open);
    win.gBrowser.removeEventListener("ContentEngineState", fixture.state);
    fixture.item.remove(); delete win.contentBridgeFixture;
  }
  windows.clear();
}
function install() {}
function uninstall() {}
