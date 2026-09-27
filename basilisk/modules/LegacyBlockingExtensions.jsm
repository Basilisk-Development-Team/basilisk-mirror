/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var EXPORTED_SYMBOLS = ["LegacyBlockingExtensions"];
const {classes:Cc, interfaces:Ci, utils:Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
const {XPIProvider} = Cu.import("resource://gre/modules/addons/XPIProvider.jsm", {});
const adapterScope = {};
Services.scriptloader.loadSubScript("chrome://browser/content/contentengine/policy-domains.js", adapterScope, "UTF-8");
Services.scriptloader.loadSubScript("chrome://browser/content/contentengine/policy-patterns.js", adapterScope, "UTF-8");
Services.scriptloader.loadSubScript("chrome://browser/content/contentengine/adapters/ublock-state.js", adapterScope, "UTF-8");
const adapter = adapterScope.UBlockStateAdapter;

// Lifecycle belongs to the application. Provider recognition/serialization is
// versioned adapter work; no extension ID is hardcoded in this service.
var LegacyBlockingExtensions = {
  listeners:new Set(), entry:null, generation:0, pending:null, timer:null, epoch:0,
  subscribe(listener) {
    this.listeners.add(listener);
    if (!this.timer) {
      ++this.epoch;
      AddonManager.addAddonListener(this);
      this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this.timer.initWithCallback(() => this.refresh().catch(Cu.reportError), 500, Ci.nsITimer.TYPE_REPEATING_SLACK);
    }
    this.refresh().catch(Cu.reportError);
  },
  unsubscribe(listener) {
    this.listeners.delete(listener);
    if (!this.listeners.size && this.timer) {
      this.timer.cancel(); this.timer=null;
      AddonManager.removeAddonListener(this);
      ++this.epoch;
      this.entry=null;
    }
  },
  onEnabled() {this.refresh().catch(Cu.reportError);},
  onDisabled() {this.refresh().catch(Cu.reportError);},
  onInstalled() {this.refresh().catch(Cu.reportError);},
  onUninstalled() {this.refresh().catch(Cu.reportError);},
  onDisabling() {this.invalidate();},
  onUninstalling() {this.invalidate();},
  invalidate() {
    ++this.epoch;
    this.entry=null; ++this.generation;
    for (const listener of this.listeners) listener();
  },
  refresh() {
    if (!this.listeners.size) return Promise.resolve({waiting:false,entry:null});
    if (this.pending) return this.pending;
    this.pending = this.scan().then(value => {this.pending=null;return value;},
      error => {this.pending=null;throw error;});
    return this.pending;
  },
  async scan() {
    const epoch=this.epoch;
    const addons = await new Promise(resolve => AddonManager.getAddonsByTypes(["extension"], resolve));
    // Add-on discovery may finish after shutdown, disabling, or another window
    // starts a new subscription. Never resurrect state from that old lifetime.
    if (epoch!==this.epoch)
      return {waiting:!!this.listeners.size,entry:null};
    let found = null, waiting = false;
    for (const addon of addons) {
      if (!addon.isActive || addon.userDisabled || addon.appDisabled || addon.version !== adapter.version) continue;
      const scope = XPIProvider.bootstrapScopes[addon.id];
      if (!scope) {waiting=true;continue;}
      const runtime=adapter.inspectRuntime(scope);
      if (!runtime) continue;
      if (runtime.waiting) {waiting=true;continue;}
      const bg=runtime.background, signature=runtime.signature;
      const old=this.entry;
      if (old && old.background===bg && old.categories===runtime.identity && old.signature===signature) {
        found=old;break;
      }
      const reuse=old && old.background===bg && old.categories===runtime.identity &&
        old.networkSignature===runtime.networkSignature;
      const started=Date.now();
      let compiled=reuse ? old.compiled : null;
      if (!compiled) {
        const steps=adapter.compileStaticNetworkSteps(adapter.snapshot(addon.version,bg));
        let step;
        do {
          // Yield to chrome between bounded translation batches. Never keep
          // one privileged JS task alive throughout a complete EasyList build.
          await new Promise(resolve => {
            const timer=Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
            timer.initWithCallback(resolve,0,Ci.nsITimer.TYPE_ONE_SHOT);
          });
          if (epoch!==this.epoch) return {waiting:!!this.listeners.size,entry:null};
          step=steps.next();
        } while (!step.done);
        compiled=step.value;
        const current=adapter.inspectRuntime(scope);
        if (!current || current.waiting || current.identity!==runtime.identity || current.signature!==signature)
          return {waiting:true,entry:this.entry};
      }
      const generation=++this.generation;
      found={id:addon.id,version:addon.version,background:bg,signature,
        categories:runtime.identity,compiled,adapter,generation,
        // Transfer bulk policy data as a value, not hundreds of thousands of
        // cross-compartment object/property accesses on the browser thread.
        ruleSource:reuse ? old.ruleSource : JSON.stringify(compiled.rules),
        networkSignature:runtime.networkSignature,
        networkGeneration:reuse ? old.networkGeneration : generation,
        translationMS:reuse ? old.translationMS : Date.now()-started};
      break;
    }
    if (waiting && !found) return {waiting:true,entry:this.entry};
    if (found !== this.entry) {
      this.entry=found;
      if (!found) ++this.generation;
      for (const listener of this.listeners) listener();
    }
    return {waiting:false,entry:found};
  },
  async ready() {
    for (let i=0;i<100;i++) {
      const state=await this.refresh();
      if (!state.waiting) return state.entry;
      await new Promise(resolve => {
        const timer=Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        timer.initWithCallback(resolve,200,Ci.nsITimer.TYPE_ONE_SHOT);
      });
    }
    throw new Error("Blocking extension state did not become ready");
  }
};
