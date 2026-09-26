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
  message(browser, json, frame) { let client = this.clients.get(browser); if (client) client.message(json, frame); },
  transfer(from, to) {
    let client = this.clients.get(from);
    if (!client) return;
    let destination = this.clients.get(to);
    if (destination && destination != client) {
      for (let listener of destination.listeners) client.listeners.add(listener);
      for (let [token, source] of destination.styles) client.styles.set(token, source);
      for (let [token, source] of destination.scripts) client.scripts.set(token, source);
      for (let [token, rules] of destination.policies) client.policies.set(token, rules);
      destination.destroy();
    }
    this.clients.delete(from);
    this.clients.set(to, client);
    return client.rebind(to);
  },
  exportDefinitions(browser) {
    let client = this.clients.get(browser);
    return client ? JSON.stringify({styles:Array.from(client.styles), scripts:Array.from(client.scripts),
      policies:Array.from(client.policies)}) : null;
  },
  importDefinitions(browser, serialized) {
    if (!serialized) return;
    let data = JSON.parse(serialized), client = this.forBrowser(browser);
    for (let name of ["styles", "scripts", "policies"])
      for (let [token, value] of data[name]) client[name].set(token, value);
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
    this.policies = new Map();
    this.receive = message => this.result(message.data.id, message.data.json, message.data.error);
    this.receiveContent = message => this.message(message.data.json, message.data.frame);
  }
  get capabilities() { return ContentEngines.capabilitiesFor(this.browser); }
  executeScript(source, options = {}) {
    if (this.closed || typeof source != "string" || source.length > 1024 * 1024)
      return Promise.reject(new Error("Invalid script or closed content view"));
    if (options.allFrames) return this.getFrames().then(frames => Promise.all(frames.map(frame =>
      this.executeScript(source, {frameId:frame.frameId}).then(result => ({frameId:frame.frameId, result})))));
    if (options.frameId !== undefined && (typeof options.frameId != "string" || !options.frameId || options.frameId.length > 128))
      return Promise.reject(new TypeError("Invalid frame ID"));
    return this.request("Execute", {source, frameId:options.frameId});
  }
  getFrames() { return this.request("Frames", {}); }
  executeWorldScript(frameId, worldId, source, globalScope = false) {
    if (typeof frameId != "string" || !frameId || frameId.length > 128 ||
        typeof worldId != "string" || !worldId || worldId.length > 128 ||
        typeof source != "string" || source.length > 1024 * 1024)
      return Promise.reject(new TypeError("Invalid execution target or script"));
    return this.request("World", {frameId, worldId, source, globalScope});
  }
  releaseWorld(worldId) {return this.request("WorldRelease", {worldId});}
  prepareWorld(worldId) {return this.request("WorldPrepare", {worldId});}
  registerWorldScript(token, worldId, source, runAt, allFrames) {
    return this.request("WorldRegister", {token,worldId,source,runAt,allFrames});
  }
  request(operation, arguments_) {
    if (this.closed) return Promise.reject(new Error("Content view closed"));
    let c = Ci.nsIWebContentView;
    let required = {WorldRelease:c.CAP_EXECUTION_WORLDS, WorldPrepare:c.CAP_EXECUTION_WORLDS, WorldRegister:c.CAP_EXECUTION_WORLDS, World:c.CAP_EXECUTION_WORLDS, Frames:c.CAP_FRAMES, Execute: c.CAP_CONTENT_SCRIPTS, CSS: c.CAP_CSS, Register: c.CAP_SCRIPT_REGISTRATION, Policy: c.CAP_REQUEST_FILTERING}[operation];
    if (!required || !(this.capabilities & required)) return Promise.reject(new Error("Unsupported content operation: " + operation));
    if ((arguments_.frameId !== undefined || arguments_.allFrames) && !(this.capabilities & c.CAP_FRAMES))
      return Promise.reject(new Error("Frame addressing unsupported"));
    if (arguments_.runAt !== undefined && !(this.capabilities & c.CAP_SCRIPT_TIMING))
      return Promise.reject(new Error("Script timing unsupported"));
    return new Promise((resolve, reject) => {
      let id = ContentEngineScripts.nextId++;
      let timer = setTimeout(() => this.result(id, "null", "Content operation timed out"), 30000);
      this.pending.set(id, {resolve, reject, timer});
      try {
        let view = ContentEngines.get(this.browser);
        if (view) {
          if (operation == "WorldRelease") view.native.releaseWorld(id, arguments_.worldId);
          else if (operation == "WorldPrepare") view.native.prepareWorld(id, arguments_.worldId);
          else if (operation == "WorldRegister") {
            view.native.registerWorldScript(arguments_.token, arguments_.worldId, arguments_.source, arguments_.runAt, !!arguments_.allFrames);
            this.result(id,"null","");
          }
          else if (operation == "World") view.native.executeWorldScript(id, arguments_.frameId, arguments_.worldId, arguments_.source, !!arguments_.globalScope);
          else if (operation == "Frames") view.native.getFrames(id);
          else if (operation == "Execute") {
            if (arguments_.frameId !== undefined) view.native.executeFrameScript(id, arguments_.frameId, arguments_.source);
            else view.native.executeScript(id, arguments_.source);
          }
          else if (operation == "Policy" && !arguments_.remove)
            view.native.setRequestRules(id, arguments_.token, arguments_.rules.length, arguments_.rules.map(rule => Object.assign({party:0, topURLPrefix:""}, rule)));
          else {
            if (operation == "CSS") {
              if (arguments_.remove) view.native.removeCSS(arguments_.token);
              else view.native.insertCSSWithOptions(arguments_.token, arguments_.source, !!arguments_.allFrames);
            } else if (operation == "Policy") view.native.removeRequestRules(arguments_.token);
            else if (operation == "Register") {
              if (arguments_.remove) view.native.unregisterScript(arguments_.token);
              else view.native.registerScriptWithOptions(arguments_.token, arguments_.source,
                arguments_.runAt === undefined ? c.SCRIPT_DOCUMENT_END : arguments_.runAt, !!arguments_.allFrames);
            }
            this.result(id, "null", "");
          }
        }
        else {
          if (this.browser.contentEngine != "gecko") throw new Error("alternate content view is pending restoration");
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
  insertCSS(source, token = "style-" + ContentEngineScripts.nextId++, options = {}) {
    if (typeof source != "string" || typeof token != "string" || !token || token.length > 256 || source.length > 1024 * 1024)
      return Promise.reject(new TypeError("Invalid stylesheet"));
    let definition = {source, allFrames:!!options.allFrames};
    return this.request("CSS", Object.assign({token}, definition)).then(() => { this.styles.set(token, definition); return token; });
  }
  removeCSS(token) {
    return this.request("CSS", {token, remove: true}).then(() => { this.styles.delete(token); });
  }
  registerScript(token, source, options = {}) {
    if (typeof source != "string" || typeof token != "string" || !token || token.length > 256 || source.length > 1024 * 1024)
      return Promise.reject(new TypeError("Invalid script registration"));
    const phases = {"document-start":0, "document-end":1, "document-idle":2};
    if (options.runAt !== undefined && !Object.prototype.hasOwnProperty.call(phases, options.runAt))
      return Promise.reject(new TypeError("Invalid script phase"));
    let definition = {source, runAt:phases[options.runAt], allFrames:!!options.allFrames};
    return this.request("Register", Object.assign({token}, definition)).then(() => { this.scripts.set(token, definition); });
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
    let operations = [];
    for (let [token, value] of this.styles) operations.push(this.request("CSS", Object.assign({token},
      typeof value == "string" ? {source:value} : value)));
    for (let [token, value] of this.scripts) operations.push(this.request("Register", Object.assign({token},
      typeof value == "string" ? {source:value} : value)));
    if (this.capabilities & Ci.nsIWebContentView.CAP_REQUEST_FILTERING)
      for (let [token, rules] of this.policies) operations.push(this.request("Policy", {token, rules}));
    this.ready = Promise.all(operations);
    return this.ready;
  }
  setRequestRules(token, rules) {
    try {
      if (typeof token != "string" || !token || token.length > 256 || !Array.isArray(rules) || !rules.length || rules.length > 1024)
        throw new TypeError("Invalid request rules");
      const types = {image:1, stylesheet:2, script:4, font:8, media:16, document:32, fetch:64, topDocument:128, subdocument:256, websocket:512, ping:1024, other:2048};
      let normalized = rules.map(rule => {
        if (!rule || Object.keys(rule).some(key => !["urlPrefix", "resourceTypes", "party", "topURLPrefix"].includes(key)))
          throw new TypeError("Unknown request-rule field");
        if (typeof rule.urlPrefix != "string" || rule.urlPrefix.length > 8192)
          throw new TypeError("Invalid URL prefix");
        let uri = Services.io.newURI(rule.urlPrefix, null, null);
        if (!["http", "https", "ws", "wss"].some(scheme => uri.schemeIs(scheme))) throw new TypeError("Expected HTTP(S)/WS(S) prefix");
        if (rule.resourceTypes !== undefined && (!Array.isArray(rule.resourceTypes) || !rule.resourceTypes.length))
          throw new TypeError("Expected resource types");
        let mask = 0;
        for (let type of rule.resourceTypes || []) {
          if (!Object.prototype.hasOwnProperty.call(types, type)) throw new TypeError("Unsupported resource type");
          mask |= types[type];
        }
        let party = ["any", "first-party", "third-party"].indexOf(rule.party === undefined ? "any" : rule.party);
        if (party < 0) throw new TypeError("Invalid party constraint");
        let topURLPrefix = "";
        if (rule.topURLPrefix !== undefined) {
          let top = Services.io.newURI(rule.topURLPrefix, null, null);
          if (typeof rule.topURLPrefix != "string" || rule.topURLPrefix.length > 8192 ||
              (!top.schemeIs("http") && !top.schemeIs("https"))) throw new TypeError("Invalid top document prefix");
          topURLPrefix = top.asciiSpec;
        }
        return {urlPrefix:uri.asciiSpec, resourceTypes:mask, party, topURLPrefix};
      });
      return this.request("Policy", {token, rules:normalized}).then(() => { this.policies.set(token, normalized); });
    } catch (error) { return Promise.reject(error); }
  }
  removeRequestRules(token) {
    let remove = this.capabilities & Ci.nsIWebContentView.CAP_REQUEST_FILTERING ?
      this.request("Policy", {token, remove:true}) : Promise.resolve();
    return remove.then(() => this.policies.delete(token));
  }
  sendMessage(value, options = {}) {
    let json;
    try { json = JSON.stringify(value); }
    catch (error) { return Promise.reject(error); }
    if (typeof json != "string") return Promise.reject(new TypeError("Message must be JSON serializable"));
    return this.executeScript("browserContent._dispatch(" + JSON.stringify(json) + ");", options);
  }
  addMessageListener(listener) {
    if (typeof listener != "function") throw new TypeError("Expected message listener");
    this.listeners.add(listener);
  }
  removeMessageListener(listener) { this.listeners.delete(listener); }
  message(json, frame) {
    try {
      if (typeof json != "string" || json.length > 1024 * 1024) return;
      let value = JSON.parse(json);
      for (let listener of this.listeners) {
        try { listener(value, frame); } catch (error) { Cu.reportError(error); }
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
    this.styles.clear(); this.scripts.clear(); this.policies.clear();
  }
}
