/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Opt-in content services. Never interpose on native Cu, Services or Gecko MM.
var LegacyXULContentRuntime = (() => {
  const {AddonManager} = Cu.import("resource://gre/modules/AddonManager.jsm", {});
  const targets = new WeakMap();
  const uuid = () => Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator).generateUUID().toString();
  const json = value => {
    let result = JSON.stringify(value);
    if (typeof result != "string" || result.length > 1024 * 1024) throw new TypeError("Expected bounded JSON data");
    return result;
  };
  const bootstrap = `(() => {
    if (globalThis.legacyContent) return;
    const listeners = new Map(), outgoing = [];
    let snapshot = Object.freeze({}), version = 0, outgoingBytes = 0;
    function freeze(value) {
      if (value && typeof value == 'object') {Object.keys(value).forEach(k => freeze(value[k])); Object.freeze(value);}
      return value;
    }
    Object.defineProperty(globalThis, 'legacyContent', {value:Object.freeze({
      getData(key) {return snapshot[key];},
      get dataVersion() {return version;},
      sendAsyncMessage(name, data) {
        if (typeof name != 'string' || name.length > 128 || outgoing.length >= 256) throw Error('Invalid message or full queue');
        const serialized = JSON.stringify(data);
        if (typeof serialized != 'string') throw Error('Invalid message');
        const size=(serialized.length+name.length+128)*3; // Conservative UTF-8 bound.
        if(outgoingBytes+size>524288)throw Error('Message queue byte limit');
        outgoingBytes+=size;outgoing.push({name, data:JSON.parse(serialized), size});
      },
      addMessageListener(name, fn) {
        if (typeof name != 'string' || typeof fn != 'function') throw TypeError('Invalid listener');
        if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn);
      },
      removeMessageListener(name, fn) {if(listeners.has(name)) listeners.get(name).delete(fn);},
      _install(next, data) {if(next <= version) throw Error('Stale configuration'); snapshot=freeze(data); version=next;},
      _dispatch(name, data) {for(const fn of listeners.get(name)||[]) fn({name, data});},
      _take() {return outgoing.splice(0,64).map(message=>{outgoingBytes-=message.size;return {name:message.name,data:message.data};});}
    })});
    for(const name of ['sendAsyncMessage','addMessageListener','removeMessageListener'])
      Object.defineProperty(globalThis, name, {value:legacyContent[name]});
  })();`;
  class Context {
    constructor(browser, addonId) {
      this.browser = browser; this.addonId = addonId; this.closed = false; this.suspended=false;
      this.owned = new Set(); this.listeners = new Map(); this.progress = new Set();
      this.client=browser.contentAPI; this.view=ContentEngines.get(browser); this.world=uuid();
      this.loading=!!this.view.native.loading;
      this.registrations=new Map(); this.styles=new Set(); this.counter=1;
      this.defaults="{}"; this.defaultVersion=1; this.registrationQueue=Promise.resolve();
      this.discovering=false; this.discoveryTimer=setInterval(()=>this.discover(),500);
      this.ready=this.client.prepareWorld(this.world);
      this.state = event => {
        if (event.target != this.browser) return;
        const started=event.detail.loading&&!this.loading;
        this.loading=event.detail.loading;
        if(this.loading)this.suspended=false;
        for (let listener of this.progress) {
          try {listener(Object.freeze(Object.assign({}, event.detail)));} catch (error) {Cu.reportError(error);}
        }
        if (ContentEngines.get(browser) !== this.view) {this.close();return;}
        for (let target of this.owned) {
          if (ContentEngines.get(browser) !== target.view || started) this.invalidate(target);
        }
      };
      this.failure=()=>{this.suspended=true;for(let target of Array.from(this.owned))this.invalidate(target);};
      browser.addEventListener("ContentEngineProcessTerminated",this.failure);
      browser.addEventListener("ContentEngineState", this.state);
      this.unload = () => this.close();
      window.addEventListener("unload", this.unload);
      this.tabClose=event=>{if(event.target.linkedBrowser===this.browser)this.close();};
      gBrowser.tabContainer.addEventListener("TabClose",this.tabClose);
      this.addonListener={onDisabling:addon=>{if(addon.id===this.addonId)this.close();},
        onUninstalling:addon=>{if(addon.id===this.addonId)this.close();}};
      AddonManager.addAddonListener(this.addonListener);
    }
    require(handle) {
      let target = targets.get(handle);
      if (this.closed || !target || target.owner !== this || !target.valid)
        throw new Error("Unknown, foreign or expired execution target");
      return target;
    }
    async createTarget(frameId) {
      if (this.closed || this.suspended) throw new Error("Extension context closed or content process unavailable");
      if (!(this.browser.contentAPI.capabilities & Ci.nsIWebContentView.CAP_EXECUTION_WORLDS))
        throw new Error("Independent execution worlds unsupported");
      await this.ready;
      let client = this.browser.contentAPI, view = ContentEngines.get(this.browser);
      let frames = await client.getFrames();
      let frame = frameId === undefined ? frames.find(f => f.isTopFrame) : frames.find(f => f.frameId === frameId);
      if (!frame || this.closed || view !== ContentEngines.get(this.browser)) throw new Error("Document unavailable");
      for(let target of this.owned) if(target.frame.frameId===frame.frameId && target.valid)return target.handle;
      let handle = Object.freeze({}), target = {owner:this, handle, frame:Object.freeze(frame), client, view,
        world:this.world, valid:true, queue:Promise.resolve(), timer:null, polling:false};
      targets.set(handle, target); this.owned.add(target);
      await this.enqueue(handle, this.initialization(), true);
      target.timer = setInterval(() => this.poll(target), 250);
      return handle;
    }
    enqueue(handle, source, globalScope) {
      let target;
      try {target = this.require(handle);} catch(error) {return Promise.reject(error);}
      const operation = target.queue.then(async () => {
        this.require(handle);
        if (ContentEngines.get(this.browser) !== target.view || this.browser.contentAPI !== target.client)
          throw new Error("Content view replaced");
        if (!(await target.client.getFrames()).some(frame => frame.frameId === target.frame.frameId)) {
          this.invalidate(target); throw new Error("Document destroyed");
        }
        this.require(handle);
        let value = await target.client.executeWorldScript(target.frame.frameId, target.world, source, globalScope);
        this.require(handle); return value;
      });
      // One failed script does not silently discard subsequent script requests.
      target.queue = operation.catch(() => {});
      return operation;
    }
    executeScript(handle, source) {return this.enqueue(handle, source, false);}
    setData(handle, value) {
      this.require(handle); let serialized = json(value), version = ++this.counter;
      return this.enqueue(handle, "legacyContent._install("+version+","+serialized+");", true);
    }
    loadSubScript(uri, handle) {
      // Reserve a queue slot before async resource loading, preserving call order.
      let target;
      try {target=this.require(handle);} catch(error) {return Promise.reject(error);}
      let result = target.queue.then(async () => {
        this.require(handle);
        const source=await this.readSource(uri);
        const parsed=Services.io.newURI(uri,null,null);
        this.require(handle);
        if (ContentEngines.get(this.browser) !== target.view) throw new Error("Content view replaced");
        try {
          await target.client.executeWorldScript(target.frame.frameId, target.world, source, true);
          this.require(handle);
        } catch(error) {throw new Error(parsed.spec+": "+error);}
      });
      target.queue = result.catch(() => {}); return result;
    }
    initialization() {
      return bootstrap+"\nif(legacyContent.dataVersion<"+this.defaultVersion+")legacyContent._install("+
        this.defaultVersion+","+this.defaults+");\n";
    }
    async readSource(uri) {
        let parsed = Services.io.newURI(uri, null, null);
        if (!['chrome','resource','file','jar'].some(s => parsed.schemeIs(s)) ||
            AddonManager.mapURIToAddonID(parsed) !== this.addonId)
          throw new Error("Script does not belong to this installed extension");
        const source = await new Promise((resolve,reject) => {
          let request = new XMLHttpRequest(); request.open('GET', parsed.spec, true);
          request.onload = () => resolve(request.responseText);
          request.onerror = () => reject(new Error("Content script load failed: "+parsed.spec)); request.send();
        });
        // Conservative eligibility check, not a security parser. Native isolation
        // and absence of privileged globals enforce the actual boundary.
        if (/\b(?:Components|Services|ChromeUtils|Cu|Cc|Ci)\b/.test(source))
          throw new Error("Privileged Gecko source is not an alternate content script: "+parsed.spec);
      return source;
    }
    setDefaultData(value) {
      const serialized=json(value);
      return this.queueRegistration(async()=>{
      if(this.closed)throw new Error("Context closed");
      this.defaults=serialized;this.defaultVersion=++this.counter;
      for(let target of this.owned)await this.enqueue(target.handle,this.initialization(),true);
      for(let [token,entry] of this.registrations)
        await this.client.registerWorldScript(token,this.world,this.initialization()+entry.source,entry.runAt,entry.allFrames);
      });
    }
    queueRegistration(action) {
      let result=this.registrationQueue.then(()=>{
        if(this.closed)throw new Error('Context closed');return action();
      });
      this.registrationQueue=result.catch(()=>{});return result;
    }
    loadFrameScript(uri, options = {}) {
      return this.queueRegistration(async()=>{
      if(this.closed)throw new Error("Context closed");
      // No promise of Gecko document-idle scheduling from this backend.
      const phases={'document-start':0,'document-end':1};
      let runAt=phases[options.runAt||'document-end'];
      if(runAt===undefined)throw new TypeError("Unknown document phase");
      await this.ready;
      let source=await this.readSource(uri),token='legacy-script-'+uuid();
      if(this.closed)throw new Error("Context closed");
      let entry={source,runAt,allFrames:!!options.allFrames};
      await this.client.registerWorldScript(token,this.world,this.initialization()+source,runAt,entry.allFrames);
      if(this.closed){await this.client.unregisterScript(token);throw new Error("Context closed");}
      this.registrations.set(token,entry);return token;
      });
    }
    removeDelayedFrameScript(token) {
      return this.queueRegistration(async()=>{
      if(!this.registrations.has(token))throw new Error("Unknown script registration");
      this.registrations.delete(token);await this.client.unregisterScript(token);
      });
    }
    async insertCSS(source, options = {}) {
      if(this.closed)throw new Error("Context closed");
      let token='legacy-style-'+uuid();
      await this.client.insertCSS(source,token,{allFrames:!!options.allFrames});
      if(this.closed){await this.client.removeCSS(token);throw new Error("Context closed");}
      this.styles.add(token);return token;
    }
    async removeCSS(token) {
      if(!this.styles.has(token))throw new Error("Unknown stylesheet");
      this.styles.delete(token);await this.client.removeCSS(token);
    }
    sendAsyncMessage(handle, name, value) {
      if (typeof name != 'string' || name.length > 128) return Promise.reject(new TypeError("Invalid message name"));
      return this.enqueue(handle, "legacyContent._dispatch("+json(name)+","+json(value)+");", true);
    }
    broadcastAsyncMessage(name, value) {
      return Promise.all(Array.from(this.owned).map(target => this.sendAsyncMessage(target.handle, name, value)));
    }
    addMessageListener(name, fn) {
      if (typeof name != 'string' || typeof fn != 'function') throw new TypeError("Invalid listener");
      if (!this.listeners.has(name)) this.listeners.set(name,new Set()); this.listeners.get(name).add(fn);
    }
    removeMessageListener(name, fn) {if(this.listeners.has(name))this.listeners.get(name).delete(fn);}
    async discover() {
      if(this.closed || this.suspended || this.discovering || !this.registrations.size)return;
      this.discovering=true;
      try {
        if(this.client.closed || ContentEngines.get(this.browser)!==this.view){await this.close();return;}
        let frames=await this.client.getFrames();
        for(let target of Array.from(this.owned))
          if(!frames.some(frame=>frame.frameId===target.frame.frameId))this.invalidate(target);
        for(let frame of frames)await this.createTarget(frame.frameId);
      } catch(error) { /* Navigation can replace a frame during discovery. */ }
      finally {this.discovering=false;}
    }
    async poll(target) {
      if (!target.valid || target.polling) return;
      target.polling=true;
      try {
        let messages=await this.executeScript(target.handle,"return legacyContent._take();");
        for(let message of messages) for(let fn of this.listeners.get(message.name)||[]) {
          try {fn(Object.freeze({name:message.name,data:message.data,target:target.handle,frame:target.frame}));}
          catch(error) {Cu.reportError(error);}
        }
      } catch(error) {this.invalidate(target);} finally {target.polling=false;}
    }
    addProgressListener(fn) {if(typeof fn!='function')throw new TypeError("Expected listener");this.progress.add(fn);}
    removeProgressListener(fn) {this.progress.delete(fn);}
    invalidate(target) {target.valid=false;clearInterval(target.timer);this.owned.delete(target);}
    destroyTarget(handle) {this.invalidate(this.require(handle));}
    close() {
      if(this.closed)return this.closing||Promise.resolve();this.closed=true;
      clearInterval(this.discoveryTimer);
      for(let target of Array.from(this.owned))this.invalidate(target);
      this.browser.removeEventListener('ContentEngineState',this.state);
      this.browser.removeEventListener('ContentEngineProcessTerminated',this.failure);
      window.removeEventListener('unload',this.unload);
      gBrowser.tabContainer.removeEventListener('TabClose',this.tabClose);this.listeners.clear();this.progress.clear();
      AddonManager.removeAddonListener(this.addonListener);
      let cleanup=[];
      for(let token of this.registrations.keys())cleanup.push(this.client.unregisterScript(token).catch(()=>{}));
      for(let token of this.styles)cleanup.push(this.client.removeCSS(token).catch(()=>{}));
      this.registrations.clear();this.styles.clear();this.defaults="{}";
      this.closing=Promise.all(cleanup.concat(this.registrationQueue)).then(()=>this.client.releaseWorld(this.world)).catch(()=>{});
      return this.closing;
    }
  }
  return Object.freeze({
    async open(browser) {
      // Identity derives from the real callsite, never a caller-supplied ID.
      let caller = Components.stack.caller;
      // UXP subscript filenames carry loader provenance as "loader -> file".
      let filename = caller && caller.filename.split(" -> ").pop();
      let id = filename && AddonManager.mapURIToAddonID(Services.io.newURI(filename,null,null));
      if (!id) throw new Error("Caller is not an installed extension resource");
      let addon = await new Promise(resolve => AddonManager.getAddonByID(id,resolve));
      if (!addon || !addon.isActive) throw new Error("Extension is inactive");
      if(!(browser.contentAPI.capabilities & Ci.nsIWebContentView.CAP_EXECUTION_WORLDS))
        throw new Error("Independent execution worlds unsupported");
      let context = new Context(browser,id), facade = {};
      try {await context.ready;} catch(error){await context.close();throw error;}
      for(let name of ['createTarget','executeScript','setData','setDefaultData','loadSubScript',
        'loadFrameScript','removeDelayedFrameScript','insertCSS','removeCSS',
        'sendAsyncMessage','broadcastAsyncMessage','addMessageListener','removeMessageListener',
        'addProgressListener','removeProgressListener','destroyTarget','close'])
        facade[name]=context[name].bind(context);
      return Object.freeze(facade);
    }
  });
})();
