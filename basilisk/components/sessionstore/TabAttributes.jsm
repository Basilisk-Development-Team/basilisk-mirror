/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["TabAttributes"];

const Cu = Components.utils;
const Cr = Components.results;

// We never want to directly read or write these attributes.
// 'image' should not be accessed directly but handled by using the
//         gBrowser.getIcon()/setIcon() methods.
// 'muted' should not be accessed directly but handled by using the
//         tab.linkedBrowser.audioMuted/toggleMuteAudio methods.
// 'pending' is used internal by sessionstore and managed accordingly.
// 'iconLoadingPrincipal' is same as 'image' that it should be handled by
//                        using the gBrowser.getIcon()/setIcon() methods.
// 'skipbackgroundnotify' is used internal by tabbrowser.xml.
const ATTRIBUTES_TO_SKIP = new Set(["image", "muted", "pending",
                                    "iconLoadingPrincipal",
                                    "skipbackgroundnotify"]);

// A set of tab attributes to persist. We will read a given list of tab
// attributes when collecting tab data and will re-set those attributes when
// the given tab data is restored to a new tab.
this.TabAttributes = Object.freeze({
  persist: function (name) {
    return TabAttributesInternal.persist(name);
  },

  get: function (tab) {
    return TabAttributesInternal.get(tab);
  },

  set: function (tab, data = {}) {
    TabAttributesInternal.set(tab, data);
  }
});

var TabAttributesInternal = {
  _attrs: new Set(),

  _isSafeAttributeName: function (name) {
    return typeof name == "string" && /^[A-Za-z_][A-Za-z0-9._-]*$/.test(name);
  },

  persist: function (name) {
    if (!this._isSafeAttributeName(name)) {
      return false;
    }

    if (this._attrs.has(name) || ATTRIBUTES_TO_SKIP.has(name)) {
      return false;
    }

    this._attrs.add(name);
    return true;
  },

  get: function (tab) {
    let data = {};

    for (let name of this._attrs) {
      if (tab.hasAttribute(name)) {
        data[name] = tab.getAttribute(name);
      }
    }

    return data;
  },

  set: function (tab, data = {}) {
    // Clear attributes.
    for (let name of this._attrs) {
      if (!this._isSafeAttributeName(name)) {
        this._attrs.delete(name);
        continue;
      }

      try {
        tab.removeAttribute(name);
      } catch (ex) {
        if (ex.result == Cr.NS_ERROR_ILLEGAL_VALUE) {
          this._attrs.delete(name);
          continue;
        }
        Cu.reportError(ex);
      }
    }

    // Set attributes.
    for (let name in data) {
      if (ATTRIBUTES_TO_SKIP.has(name) || !this._isSafeAttributeName(name)) {
        continue;
      }

      let value = data[name];
      if (value === null || value === undefined) {
        continue;
      }

      value = String(value);
      if (value.indexOf("\0") != -1) {
        value = value.replace(/\0/g, "");
      }

      try {
        tab.setAttribute(name, value);
      } catch (ex) {
        if (ex.result == Cr.NS_ERROR_ILLEGAL_VALUE) {
          this._attrs.delete(name);
          continue;
        }
        Cu.reportError(ex);
      }
    }
  }
};
