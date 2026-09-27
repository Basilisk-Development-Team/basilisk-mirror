/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// Explicitly versioned extension adapter, not a legacy Gecko service. This
// reader is deliberately separate from the generic policy API and backend.
// It takes a live privileged background object supplied by the owning browser
// integration. Never expose that object or this reader to content scripts.
var UBlockStateAdapter = Object.freeze({
  version: "1.16.6.1",

  inspectRuntime(scope) {
    const Cu=Components.utils;
    const Services=Cu.import("resource://gre/modules/Services.jsm",{}).Services;
    let background;
    try {background=Cu.evalInSandbox("typeof bgProcess !== 'undefined' && bgProcess && bgProcess.contentWindow",scope);}
    catch (_) {return null;}
    if (!background || !Services.scriptSecurityManager.isSystemPrincipal(background.document.nodePrincipal)) return null;
    background=background.wrappedJSObject;
    const u=background.µBlock;
    if (!u || !u.staticNetFilteringEngine || !u.cosmeticFilteringEngine) return null;
    if (u.loadingFilterLists || !u.staticNetFilteringEngine.frozen || !u.cosmeticFilteringEngine.frozen)
      return {waiting:true};
    const engine=u.staticNetFilteringEngine;
    return {background, identity:engine.categories,
      networkSignature:JSON.stringify([engine.acceptedCount,engine.discardedCount]),
      signature:JSON.stringify([engine.acceptedCount,engine.discardedCount,
        u.cosmeticFilteringEngine.acceptedCount,u.cosmeticFilteringEngine.discardedCount,
        u.stringFromWhitelist(u.netWhitelist),u.sessionFirewall.toArray(),
        u.sessionURLFiltering.toArray(),u.sessionSwitches.toArray(),u.userSettings])};
  },

  updateBrowserState(background,browser,previousURI) {
    let reported=previousURI;
    background.vAPI.tabs.get(null,info=> {
      if (!info || background.vAPI.tabs.get(info.id)!==browser) return;
      const uri=browser.currentURI.spec;
      if (uri!==previousURI) {
        background.vAPI.tabs.onNavigation({frameId:0,tabId:info.id,url:uri});
        reported=uri;
      }
    });
    return reported;
  },

  // Decode the pinned extension's EFFECTIVE compiled classes. This does not
  // parse ABP/EasyList text; uBlock remains responsible for list parsing,
  // badfilter elimination and building the active engine.
  compileStaticNetwork(snapshot) {
    const steps=this.compileStaticNetworkSteps(snapshot);
    let step;
    do {step=steps.next();} while (!step.done);
    return step.value;
  },

  *compileStaticNetworkSteps(snapshot) {
    if (snapshot.extensionVersion !== this.version || snapshot.schema !== 1)
      throw new Error("Unsupported uBlock snapshot");
    const groups = [[], [], []], unsupported = [];
    const types = [null, "stylesheet", "image", null, "script", "fetch",
      "subdocument", "font", "media", "websocket", "other"];
    const ordinary = ["stylesheet", "image", "script", "fetch", "subdocument",
      "font", "media", "websocket", "other", "ping"];
    function literal(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    function pattern(value) {
      return value.split("*").map(part => part.split("^").map(literal)
        .join("([^%.0-9a-z_-]|$)")).join(".*");
    }
    const host = "^[a-z-]+://([^/?#]*@)?([^/?#:@]*\\.)?";
    function emit(bits, data, documents, excludeDocument = false) {
      if (!Array.isArray(data)) data=[0];
      const id = data[0];
      if (id === 16) { emit(bits, data[1],documents,excludeDocument); emit(bits, data[2],documents,excludeDocument); return; }
      if (id === 17) { for (const child of data[1]) emit(bits, child,documents,excludeDocument); return; }
      if (id === 15) { for (const name of data[1]) emit(bits, [4, name],documents,excludeDocument); return; }
      if (id===13) {
        try {
          const names=data[1].split('|');
          const include=names.filter(name=>name[0]!=='~');
          const exclude=names.filter(name=>name[0]==='~').map(name=>name.slice(1));
          // Pure exclusion sets map directly to the generic negated union.
          // Expanding their complement into thousands of positive regexes is
          // equivalent for DNS hosts but needlessly expensive to compile.
          const negative=!include.length && !!exclude.length;
          emit(bits,data[2],ContentPolicyDomains.patterns(negative ? exclude : include,
            negative ? [] : exclude),negative);
        } catch(error) {unsupported.push({reason:error.message,category:bits,classId:id});}
        return;
      }
      let type = (bits & 0x1f0) >>> 4;
      // Behavioral filters are evaluated by different uBlock services. None
      // of the ordinary resource masks emitted here include these categories;
      // their exceptions therefore cannot invalidate this network policy.
      if (type>=11 && type<=19) {
        unsupported.push({reason:"behavioral category",category:bits,networkException:false});
        return;
      }
      if (type===3) {
        // The backend cannot identify legacy plugin/object requests. Dropping
        // an object exception could overblock: preserve its URL/domain/party
        // predicate but conservatively allow every ordinary resource class.
        // This intentionally underblocks that narrow predicate and is reported.
        unsupported.push({reason:"object attribution unavailable",category:bits,
          networkException:false,conservativeException:!!(bits&1)});
        if (!(bits&1)) return;
        type=0;
      }
      if ((bits & ~0x1ff) || (bits & 12) === 12 || (type && !types[type])) {
        unsupported.push({reason:"resource category", category:bits}); return;
      }
      let regex;
      if (id === 0) regex = ".*";
      else if (id >= 1 && id <= 3) regex = literal(data[1]);
      // Network policy receives serialized URLs. HTTP(S)/WS(S) authorities
      // always have a slash, including an otherwise empty path. Avoid two
      // duplicate automata for impossible bare-authority/query-only forms.
      else if (id === 4) regex = host + literal(data[1]) + "(:[0-9]+)?/";
      else if (id === 5) regex = "^" + literal(data[1]);
      else if (id === 6) regex = literal(data[1]) + "$";
      else if (id === 7) regex = "^" + literal(data[1]) + "$";
      else if (id === 8) regex = host + literal(data[1]);
      else if (id === 9) regex = ((data[2] & 4) ? host : (data[2] & 2) ? "^" : "") +
        pattern(data[1]) + ((data[2] & 1) ? "$" : "");
      else if (id === 10 || id === 11) regex = host + pattern(data[1]) + (id === 11 ? "$" : "");
      else if (id === 12) regex = data[1];
      else { unsupported.push({reason:"compiled class", category:bits, classId:id}); return; }
      try {
        if (documents && !documents.length) return;
        // Fixed-string/hostname classes already use the backend's regex
        // subset. Reserve finite-alternation/quantifier lowering for classes
        // which actually contain those constructs, rather than reparsing every
        // hostname in large dictionaries on an interpreter-only platform.
        if (!/^[\x20-\x7e]+$/.test(regex) || regex.length>8192)
          throw new Error("Unsupported pattern size or character");
        const patterns=id>=9 && id<=12 ? ContentPolicyPatterns.expand(regex,false) : [regex];
        for (const urlPattern of patterns) {
            const rule={
              urlPattern, caseSensitive:false,
              resourceTypes:type ? [types[type]] : ordinary.slice(),
              party:bits & 8 ? "third-party" : bits & 4 ? "first-party" : "any",
              action:bits & 1 ? "allow" : "block"
            };
            if (documents) {rule.documentURLPatterns=documents;rule.excludeDocumentURL=excludeDocument;}
            groups[bits & 2 ? 2 : bits & 1 ? 1 : 0].push(rule);
        }
      } catch(error) {unsupported.push({reason:error.message,category:bits,classId:id});}

    }
    let processed=0;
    for (const category of snapshot.network.categories)
      for (const entry of category[1]) {
        emit(category[0], entry[1]);
        if (++processed % 256 === 0) yield;
      }
    // Missing allow predicates cannot just be dropped: that would overblock.
    // Caller must explicitly handle unsupported state, never call this a full
    // effective-policy replacement when unsupported entries remain.
    // Rules within one precedence class all make the same decision. Union
    // their resource masks rather than emitting an identical URL automaton
    // separately for every resource type. Never merge across precedence.
    const merged=[];
    for (const group of groups) {
      const entries=new Map();
      for (const rule of group) {
        if (++processed % 256 === 0) yield;
        const key=JSON.stringify([rule.urlPattern,rule.documentURLPatterns,rule.excludeDocumentURL,rule.party,rule.action]);
        const previous=entries.get(key);
        if (previous) {
          for (const type of rule.resourceTypes)
            if (!previous.resourceTypes.includes(type)) previous.resourceTypes.push(type);
        } else entries.set(key,rule);
      }
      merged.push(Array.from(entries.values()));
    }
    return {rules:merged[0].concat(merged[1], merged[2]), unsupported};
  },

  // Top-document declarative cosmetics only. No fake DOM target is supplied
  // to the extension, and no Gecko tab/frame IDs are passed to its CSS injector.
  pageState(version, background, uri) {
    if (version !== this.version) throw new Error("Unsupported uBlock state version");
    if (background && background.wrappedJSObject) background = background.wrappedJSObject;
    const u = background.µBlock;
    const enabled = u.getNetFilteringSwitch(uri);
    if (!enabled) return {enabled:false, css:"", procedural:[]};
    const hostname = u.URI.hostnameFromURI(uri);
    const domain = u.URI.domainFromHostname(hostname);
    const noCosmetic=u.sessionSwitches.evaluateZ("no-cosmetic-filtering", hostname);
    const noGeneric=noCosmetic || u.userSettings.ignoreGenericCosmeticFilters ||
      u.staticNetFilteringEngine.matchStringGenericHide(null,uri)===2;
    const result = u.cosmeticFilteringEngine.retrieveDomainSelectors({
      hostname, domain, entity:u.URI.entityFromDomain(domain)
    }, {noCosmeticFiltering:noCosmetic,
        noGenericCosmeticFiltering:true});
    if (!result.ready) throw new Error("uBlock cosmetic generation is not ready");
    const selectors=new Set(result.declarativeFilters);
    if (!noGeneric) {
      // Install the extension's effective declarative selectors directly. CSS
      // already tracks dynamic DOM changes; no privileged DOM survey is needed.
      const engine=u.cosmeticFilteringEngine;
      for (const name of Object.keys(engine.lowlyGeneric)) {
        const entry=engine.lowlyGeneric[name];
        for (const key of entry.simple) {
          const complex=entry.complex.get(key);
          if (Array.isArray(complex)) for (const selector of complex) selectors.add(selector);
          else selectors.add(complex || entry.prefix+key);
        }
      }
      for (const name of Object.keys(engine.highlyGeneric))
        for (const selector of engine.highlyGeneric[name].dict) selectors.add(selector);
      for (const selector of result.exceptionFilters) selectors.delete(selector);
    }
    return {enabled:true,
      // One rule per selector prevents unsupported selector syntax from
      // invalidating otherwise supported, unrelated cosmetic rules.
      css:Array.from(selectors,selector=>selector+"\n{display:none!important;}").join("\n"),
      procedural:JSON.parse(JSON.stringify(result.proceduralFilters))};
  },

  snapshot(version, background) {
    if (version !== this.version)
      throw new Error("Unsupported uBlock state version: " + version);
    // A chrome Window passed across scriptloader compartments is Xrayed again.
    // Explicitly unwrap this PRIVILEGED extension background window only; no
    // alternate-content DOM window is accepted or returned by this adapter.
    if (background && background.wrappedJSObject) background = background.wrappedJSObject;
    const u = background && background.µBlock;
    if (!u || !u.systemSettings || u.systemSettings.compiledMagic !== 4 ||
        u.systemSettings.selfieMagic !== 2)
      throw new Error("Unsupported uBlock state schema: " + JSON.stringify(u && u.systemSettings));
    if (u.loadingFilterLists || !u.staticNetFilteringEngine.frozen)
      throw new Error("uBlock rule generation is not ready");

    // Read the LIVE frozen engine: goodFilters can be empty after a selfie
    // restore, while the on-disk selfie may be absent or stale after an edit.
    // toSelfie traverses effective categories without matching requests or
    // touching the match registers used by Gecko's live filtering path.
    const network = u.staticNetFilteringEngine.toSelfie();
    const state = {
      schema: 1,
      extensionVersion: version,
      network: {
        categories: JSON.parse(network.categories),
        dataFilters: JSON.parse(network.dataFilters)
      },
      session: {
        firewall: u.sessionFirewall.toArray(),
        urls: u.sessionURLFiltering.toArray(),
        switches: u.sessionSwitches.toArray()
      },
      permanent: {
        firewall: u.permanentFirewall.toArray(),
        urls: u.permanentURLFiltering.toArray(),
        switches: u.permanentSwitches.toArray()
      },
      whitelist: u.stringFromWhitelist(u.netWhitelist),
      settings: {
        advancedUserEnabled: !!u.userSettings.advancedUserEnabled,
        parseAllABPHideFilters: !!u.userSettings.parseAllABPHideFilters,
        ignoreGenericCosmeticFilters: !!u.userSettings.ignoreGenericCosmeticFilters
      }
    };
    // Own all returned data; no extension objects/closures cross the adapter.
    // Bound this operation per generation, never per resource request.
    const serialized = JSON.stringify(state);
    if (serialized.length > 32 * 1024 * 1024)
      throw new Error("uBlock state exceeds snapshot limit");
    const result = JSON.parse(serialized);
    function freeze(value) {
      if (value && typeof value === "object") {
        for (const key of Object.keys(value)) freeze(value[key]);
        Object.freeze(value);
      }
      return value;
    }
    return freeze(result);
  }
});
