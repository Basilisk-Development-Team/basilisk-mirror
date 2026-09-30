/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
this.EXPORTED_SYMBOLS = ["ContentStorage"];
const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AsyncShutdown.jsm");
Cu.import("resource:///modules/WebKitConfig.jsm");

var ContentStorage = {
  _initialized: false,
  _pending: null,

  init() {
    if (this._initialized) return;
    this._initialized = true;
    Services.obs.addObserver(this, "cookie-changed", false);
    AsyncShutdown.profileBeforeChange.addBlocker("Content engine cookies", () => {
      // "Keep until I close the browser" applies even when history cleanup
      // is disabled. Also await any deletion started by the cookie manager.
      if (Services.prefs.getIntPref("network.cookie.lifetimePolicy") == 2) {
        return this.clearCookies();
      }
      return this._pending;
    });
  },

  observe(subject, topic, data) {
    if (topic == "cookie-changed" && data == "cleared") {
      this.clearCookies().catch(Cu.reportError);
    }
  },

  clearCookies() {
    if (!WebKitConfig.enabled) return this._pending || Promise.resolve();
    // Serialize requests: a later clear must also delete cookies created
    // while an earlier operation was in flight.
    let previous = this._pending || Promise.resolve();
    let pending = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      if (!WebKitConfig.enabled) { resolve(); return; }
      Cc["@basilisk-browser.org/content-storage;1?engine=webkit"]
        .getService(Ci.nsIContentStorage).clearCookies({
          observe(subject, topic, data) {
            if (data == "success") resolve();
            else reject(new Error("Content engine cookie deletion failed"));
          }
        });
    }));
    this._pending = pending;
    let forget = () => { if (this._pending === pending) this._pending = null; };
    pending.then(forget, forget);
    return pending;
  }
};
