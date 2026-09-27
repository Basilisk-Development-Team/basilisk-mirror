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

  // Decode the pinned extension's EFFECTIVE compiled classes. This does not
  // parse ABP/EasyList text; uBlock remains responsible for list parsing,
  // badfilter elimination and building the active engine.
  compileStaticNetwork(snapshot) {
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
    function emit(bits, data) {
      const id = data[0];
      if (id === 16) { emit(bits, data[1]); emit(bits, data[2]); return; }
      if (id === 17) { for (const child of data[1]) emit(bits, child); return; }
      if (id === 15) { for (const name of data[1]) emit(bits, [4, name]); return; }
      let type = (bits & 0x1f0) >>> 4;
      if ((bits & ~0x1ff) || (bits & 12) === 12 || (type && !types[type])) {
        unsupported.push({reason:"resource category", category:bits}); return;
      }
      let regex;
      if (id === 0) regex = ".*";
      else if (id >= 1 && id <= 3) regex = literal(data[1]);
      else if (id === 4) regex = host + literal(data[1]) + "(:[0-9]+)?([/?#]|$)";
      else if (id === 5) regex = "^" + literal(data[1]);
      else if (id === 6) regex = literal(data[1]) + "$";
      else if (id === 7) regex = "^" + literal(data[1]) + "$";
      else if (id === 8) regex = host + literal(data[1]);
      else if (id === 9) regex = ((data[2] & 4) ? host : (data[2] & 2) ? "^" : "") +
        pattern(data[1]) + ((data[2] & 1) ? "$" : "");
      else if (id === 10 || id === 11) regex = host + pattern(data[1]) + (id === 11 ? "$" : "");
      else if (id === 12) regex = data[1];
      else { unsupported.push({reason:"compiled class", category:bits, classId:id}); return; }
      groups[bits & 2 ? 2 : bits & 1 ? 1 : 0].push({
        urlPattern:regex, caseSensitive:false,
        resourceTypes:type ? [types[type]] : ordinary.slice(),
        party:bits & 8 ? "third-party" : bits & 4 ? "first-party" : "any",
        action:bits & 1 ? "allow" : "block"
      });
    }
    for (const category of snapshot.network.categories)
      for (const entry of category[1]) emit(category[0], entry[1]);
    // Missing allow predicates cannot just be dropped: that would overblock.
    // Caller must explicitly handle unsupported state, never call this a full
    // effective-policy replacement when unsupported entries remain.
    return {rules:groups[0].concat(groups[1], groups[2]), unsupported};
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
    const result = u.cosmeticFilteringEngine.retrieveDomainSelectors({
      hostname, domain, entity:u.URI.entityFromDomain(domain)
    }, {noCosmeticFiltering:u.sessionSwitches.evaluateZ("no-cosmetic-filtering", hostname),
        noGenericCosmeticFiltering:true});
    if (!result.ready) throw new Error("uBlock cosmetic generation is not ready");
    return {enabled:true,
      css:result.declarativeFilters.length ? result.declarativeFilters.join(",\n") +
        "\n{display:none!important;}" : "",
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
