/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentEngineScripts = {
  clients: new WeakMap(), nextId: 1,
  forBrowser(browser) {
    if (!this.clients.has(browser)) this.clients.set(browser, new ContentScriptClient(browser));
    return this.clients.get(browser);
  },
  result(browser, info) {
    let client = this.clients.get(browser);
    if (client) client.result(info.getPropertyAsUint32("id"),
      info.getPropertyAsAUTF8String("json"), info.getPropertyAsAUTF8String("error"));
  },
  close(browser) { let client = this.clients.get(browser); if (client) client.destroy(); }
};
class ContentScriptClient {
  constructor(browser) {
    this.browser = browser;
    this.pending = new Map();
    this.receive = message => this.result(message.data.id, message.data.json, message.data.error);
  }
  executeScript(source) {
    if (this.closed || typeof source != "string" || source.length > 1024 * 1024)
      return Promise.reject(new Error("Invalid script or closed content view"));
    return new Promise((resolve, reject) => {
      let id = ContentEngineScripts.nextId++;
      let timer = setTimeout(() => this.result(id, "null", "Content operation timed out"), 30000);
      this.pending.set(id, {resolve, reject, timer});
      try {
        let view = ContentEngines.get(this.browser);
        if (view) view.native.executeScript(id, source);
        else {
          if (this.browser.contentEngine == "webkit") throw new Error("WPE view is pending restoration");
          if (!this.manager) {
            this.manager = this.browser.messageManager;
            this.manager.addMessageListener("Basilisk:ContentResult", this.receive);
            this.manager.loadFrameScript("chrome://browser/content/webkit/gecko-content.js", true);
          }
          this.manager.sendAsyncMessage("Basilisk:ContentExecute", {id, source});
        }
      } catch (error) { this.result(id, "null", String(error)); }
    });
  }
  result(id, json, error) {
    let request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(new Error(error));
    else {
      try { request.resolve(JSON.parse(json)); }
      catch (error) { request.reject(error); }
    }
  }
  destroy() {
    this.closed = true;
    for (let id of Array.from(this.pending.keys())) this.result(id, "null", "Content view closed");
    if (this.manager) this.manager.removeMessageListener("Basilisk:ContentResult", this.receive);
  }
}
