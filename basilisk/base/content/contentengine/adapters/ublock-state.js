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

  snapshot(version, background) {
    if (version !== this.version)
      throw new Error("Unsupported uBlock state version: " + version);
    const u = background && background.µBlock;
    if (!u || !u.systemSettings || u.systemSettings.compiledMagic !== 4 ||
        u.systemSettings.selfieMagic !== 2)
      throw new Error("Unsupported uBlock state schema");
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
