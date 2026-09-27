/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
Cu.import("resource:///modules/LegacyBlockingExtensions.jsm");
var ContentEngineBlocking = {
  states:new WeakMap(), token:"application-legacy-blocker", active:false,
  init() {
    this.changed=()=> {
      for (const view of ContentEngines.views.values())
        this.prepare(view,(this.states.get(view)||{}).uri || view.native.currentURI || "about:blank").catch(Cu.reportError);
    };
    window.addEventListener("unload",()=>LegacyBlockingExtensions.unsubscribe(this.changed),{once:true});
    gBrowser.tabContainer.addEventListener("TabSelect",()=>this.updatePage(gBrowser.selectedBrowser));
  },
  prepare(view,uri) {
    if (view.destroyed) return Promise.resolve();
    // Gecko-only windows need no alternate policy translation. Discovery and
    // synchronization start automatically when the first alternate view needs
    // a policy, then remain active for this window's lifetime.
    if (!this.active) {
      this.active=true;
      LegacyBlockingExtensions.subscribe(this.changed);
    }
    let state=this.states.get(view);
    if (!state) {state={queue:Promise.resolve(),revision:0};this.states.set(view,state);}
    state.uri=uri;
    const revision=++state.revision;
    const work=async()=> {
      const entry=await LegacyBlockingExtensions.ready();
      if (view.destroyed || state.revision!==revision) return;
      const api=view.browser.contentAPI;
      const key=(entry ? entry.generation : "none")+":"+uri;
      if (state.key===key) return;
      await api.removeCSS(this.token);
      if (view.destroyed || state.revision!==revision) return;
      if (!entry || !/^https?:/.test(uri)) {
        await api.removeRequestRules(this.token); state.networkKey=null; state.hasNetwork=false; state.key=key; return;
      }
      const page=entry.adapter.pageState(entry.version,entry.background,uri);
      if (!page.enabled) {
        if (state.hasNetwork) view.native.setRequestRulesEnabled(this.token,false);
      } else {
        if (entry.compiled.unsupported.some(item => (item.category & 1) && item.networkException!==false))
          throw new Error("Unsupported blocking extension exception; refusing an overblocking policy");
        if (state.networkKey !== entry.networkGeneration) {
          if (entry.compiled.rules.length)
            await api.setRequestRules(this.token,JSON.parse(entry.ruleSource),{persistAcrossViews:false});
          else await api.removeRequestRules(this.token);
          state.networkKey=entry.networkGeneration;
          state.hasNetwork=!!entry.compiled.rules.length;
        }
        if (view.destroyed || state.revision!==revision) return;
        if (state.hasNetwork) view.native.setRequestRulesEnabled(this.token,true);
        if (page.css) await api.insertCSS(page.css,this.token,{persistAcrossViews:false});
      }
      state.key=key;
      view.browser.setAttribute("contentblocking",page.enabled ?
        (entry.compiled.unsupported.length ? "partial" : "active") : "disabled");
      view.browser.setAttribute("contentblockingunsupported",String(entry.compiled.unsupported.length));
      this.updatePage(view.browser);
    };
    // Serialize replacements for a view. A failed compile leaves the previous
    // native policy intact; navigation preparation rejects rather than bypasses.
    state.queue=state.queue.catch(()=>{}).then(work);
    return (async()=> {
      let last;
      do {last=state.queue;await last;} while (last!==state.queue);
    })();
  },
  updatePage(browser) {
    const view=ContentEngines.get(browser),entry=LegacyBlockingExtensions.entry;
    if (!view || !entry || browser!==gBrowser.selectedBrowser) return;
    const state=this.states.get(view);
    if (state) state.reportedURI=entry.adapter.updateBrowserState(entry.background,browser,state.reportedURI);
  }
};
