/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentEngineScripts = {
  clients: new WeakMap(), managers: new WeakMap(), nextId: 1,
  forBrowser(browser) {
    if (!this.clients.has(browser)) this.clients.set(browser, new ContentScriptClient(browser));
    return this.clients.get(browser);
  },
  result(browser, info) {
    let client = this.clients.get(browser);
    if (client) client.result(info.getPropertyAsUint32("id"),
      info.getPropertyAsAUTF8String("json"), info.getPropertyAsAUTF8String("error"));
  },
  message(browser, json) { let client = this.clients.get(browser); if (client) client.message(json); },
  transfer(from, to) {
    let client = this.clients.get(from);
    if (!client) return;
    let destination = this.clients.get(to);
    if (destination && destination != client) {
      for (let listener of destination.listeners) client.listeners.add(listener);
      for (let [token, source] of destination.styles) client.styles.set(token, source);
      for (let [token, source] of destination.scripts) client.scripts.set(token, source);
      destination.destroy();
    }
    this.clients.delete(from);
    this.clients.set(to, client);
    client.rebind(to);
  },
  close(browser) { let client = this.clients.get(browser); if (client) client.destroy(); }
};
class ContentScriptClient {
  constructor(browser) {
    this.browser = browser;
    this.pending = new Map();
    this.listeners = new Set();
    this.styles = new Map();
    this.scripts = new Map();
    this.receive = message => this.result(message.data.id, message.data.json, message.data.error);
    this.receiveContent = message => this.message(message.data.json);
  }
  executeScript(source) {
    if (this.closed || typeof source != "string" || source.length > 1024 * 1024)
      return Promise.reject(new Error("Invalid script or closed content view"));
    return this.request("Execute", {source});
  }
  request(operation, arguments_) {
    if (this.closed) return Promise.reject(new Error("Content view closed"));
    return new Promise((resolve, reject) => {
      let id = ContentEngineScripts.nextId++;
      let timer = setTimeout(() => this.result(id, "null", "Content operation timed out"), 30000);
      this.pending.set(id, {resolve, reject, timer});
      try {
        let view = ContentEngines.get(this.browser);
        if (view) {
          if (operation == "Execute") view.native.executeScript(id, arguments_.source);
          else {
            if (operation == "CSS") {
              if (arguments_.remove) view.native.removeCSS(arguments_.token);
              else view.native.insertCSS(arguments_.token, arguments_.source);
            } else if (operation == "Register") {
              if (arguments_.remove) view.native.unregisterScript(arguments_.token);
              else view.native.registerScript(arguments_.token, arguments_.source);
            }
            this.result(id, "null", "");
          }
        }
        else {
          if (this.browser.contentEngine == "webkit") throw new Error("alternate content view is pending restoration");
          if (!this.manager) {
            this.manager = this.browser.messageManager;
            this.manager.addMessageListener("Basilisk:ContentResult", this.receive);
            this.manager.addMessageListener("Basilisk:ContentMessage", this.receiveContent);
            if (ContentEngineScripts.managers.get(this.browser) != this.manager) {
              this.manager.loadFrameScript("chrome://browser/content/contentengine/gecko-content.js", true);
              ContentEngineScripts.managers.set(this.browser, this.manager);
            }
          }
          this.manager.sendAsyncMessage("Basilisk:Content" + operation, Object.assign({id}, arguments_));
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
  insertCSS(source, token = "style-" + ContentEngineScripts.nextId++) {
    if (typeof source != "string" || typeof token != "string" || !token || token.length > 256 || source.length > 1024 * 1024)
      return Promise.reject(new TypeError("Invalid stylesheet"));
    return this.request("CSS", {token, source}).then(() => { this.styles.set(token, source); return token; });
  }
  removeCSS(token) {
    return this.request("CSS", {token, remove: true}).then(() => { this.styles.delete(token); });
  }
  registerScript(token, source) {
    if (typeof source != "string" || typeof token != "string" || !token || token.length > 256 || source.length > 1024 * 1024)
      return Promise.reject(new TypeError("Invalid script registration"));
    return this.request("Register", {token, source}).then(() => { this.scripts.set(token, source); });
  }
  unregisterScript(token) {
    return this.request("Register", {token, remove: true}).then(() => { this.scripts.delete(token); });
  }
  disconnect() {
    for (let id of Array.from(this.pending.keys())) this.result(id, "null", "Content backend changed");
    if (this.manager) {
      try { this.manager.sendAsyncMessage("Basilisk:ContentReset", {}); }
      catch (error) { /* The real Gecko frame loader may already be closed. */ }
      this.manager.removeMessageListener("Basilisk:ContentResult", this.receive);
      this.manager.removeMessageListener("Basilisk:ContentMessage", this.receiveContent);
      this.manager = null;
    }
  }
  rebind(browser) {
    this.disconnect();
    this.browser = browser;
    for (let [token, source] of this.styles) this.request("CSS", {token, source}).catch(Cu.reportError);
    for (let [token, source] of this.scripts) this.request("Register", {token, source}).catch(Cu.reportError);
  }
  sendMessage(value) {
    let json;
    try { json = JSON.stringify(value); }
    catch (error) { return Promise.reject(error); }
    if (typeof json != "string") return Promise.reject(new TypeError("Message must be JSON serializable"));
    return this.executeScript("browserContent._dispatch(" + JSON.stringify(json) + ");");
  }
  addMessageListener(listener) {
    if (typeof listener != "function") throw new TypeError("Expected message listener");
    this.listeners.add(listener);
  }
  removeMessageListener(listener) { this.listeners.delete(listener); }
  message(json) {
    try {
      if (typeof json != "string" || json.length > 1024 * 1024) return;
      let value = JSON.parse(json);
      for (let listener of this.listeners) {
        try { listener(value); } catch (error) { Cu.reportError(error); }
      }
    } catch (error) { Cu.reportError(error); }
  }
  destroy() {
    this.disconnect();
    this.closed = true;
    for (let id of Array.from(this.pending.keys())) this.result(id, "null", "Content view closed");
    if (this.manager) this.manager.removeMessageListener("Basilisk:ContentResult", this.receive);
    if (this.manager) this.manager.removeMessageListener("Basilisk:ContentMessage", this.receiveContent);
    this.listeners.clear();
    this.styles.clear(); this.scripts.clear();
  }
}
