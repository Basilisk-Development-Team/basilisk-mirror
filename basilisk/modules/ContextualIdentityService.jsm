/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["ContextualIdentityService"];

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "JSONFile",
                                  "resource://gre/modules/JSONFile.jsm");

const CONTAINERS_FILE = "containers.json";
const CONTAINERS_VERSION = 1;

const PREF_ENABLED = "privacy.userContext.enabled";
const PREF_UI_ENABLED = "privacy.userContext.ui.enabled";

const DEFAULT_IDENTITIES = [
  { userContextId: 1, nameKey: "userContextPersonal.label", icon: "fingerprint", color: "blue" },
  { userContextId: 2, nameKey: "userContextWork.label", icon: "briefcase", color: "orange" },
  { userContextId: 3, nameKey: "userContextBanking.label", icon: "dollar", color: "green" },
  { userContextId: 4, nameKey: "userContextShopping.label", icon: "cart", color: "pink" },
];

const ICONS = [
  "fingerprint",
  "briefcase",
  "dollar",
  "cart",
  "circle",
];

const COLORS = [
  "blue",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
];

const COLOR_VALUES = {
  blue: "#37adff",
  turquoise: "#00c79a",
  green: "#51cd00",
  yellow: "#ffcb00",
  orange: "#ff9f00",
  red: "#ff613d",
  pink: "#ff4bda",
  purple: "#bf65ff",
};

const TOPIC_IDENTITY_ADDED = "contextual-identity-added";
const TOPIC_IDENTITY_UPDATED = "contextual-identity-updated";
const TOPIC_IDENTITY_REMOVED = "contextual-identity-removed";

XPCOMUtils.defineLazyGetter(this, "gContainersBundle", () =>
  Services.strings.createBundle("chrome://browser/locale/containers.properties")
);

function getString(name) {
  try {
    return gContainersBundle.GetStringFromName(name);
  } catch (ex) {
    return name;
  }
}

function cloneIdentity(identity) {
  return {
    userContextId: identity.userContextId,
    name: identity.name,
    icon: identity.icon,
    color: identity.color,
  };
}

var ContextualIdentityService = {
  _store: null,

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  },

  set enabled(value) {
    Services.prefs.setBoolPref(PREF_ENABLED, !!value);
    Services.prefs.setBoolPref(PREF_UI_ENABLED, !!value);
  },

  get uiEnabled() {
    return Services.prefs.getBoolPref(PREF_UI_ENABLED, false);
  },

  getAvailableIcons() {
    return ICONS.slice();
  },

  getAvailableColors() {
    return COLORS.slice();
  },

  getColorCode(color) {
    return COLOR_VALUES[color] || color || "#000000";
  },

  getColorLabel(color) {
    return getString(`userContextColor.${color}.label`);
  },

  getIconLabel(icon) {
    return getString(`userContextIcon.${icon}.label`);
  },

  getPublicIdentities() {
    let data = this._getStore().data;
    return data.identities.map(cloneIdentity);
  },

  getIdentityFromId(userContextId) {
    if (!userContextId) {
      return null;
    }
    let data = this._getStore().data;
    for (let identity of data.identities) {
      if (identity.userContextId == userContextId) {
        return cloneIdentity(identity);
      }
    }
    return null;
  },

  createIdentity(name, icon, color) {
    let data = this._getStore().data;
    let userContextId = data.lastUserContextId + 1;
    data.lastUserContextId = userContextId;

    let identity = {
      userContextId,
      name: name || "",
      icon: ICONS.includes(icon) ? icon : "circle",
      color: COLORS.includes(color) ? color : "blue",
    };
    data.identities.push(identity);
    this._save();
    this._notify(TOPIC_IDENTITY_ADDED, userContextId);
    return cloneIdentity(identity);
  },

  updateIdentity(userContextId, { name, icon, color }) {
    let data = this._getStore().data;
    let identity = data.identities.find(item => item.userContextId == userContextId);
    if (!identity) {
      return null;
    }

    if (typeof name == "string") {
      identity.name = name;
    }
    if (icon && ICONS.includes(icon)) {
      identity.icon = icon;
    }
    if (color && COLORS.includes(color)) {
      identity.color = color;
    }

    this._save();
    this._notify(TOPIC_IDENTITY_UPDATED, userContextId);
    return cloneIdentity(identity);
  },

  removeIdentity(userContextId) {
    let data = this._getStore().data;
    let index = data.identities.findIndex(item => item.userContextId == userContextId);
    if (index == -1) {
      return false;
    }

    data.identities.splice(index, 1);
    this._save();
    this._notify(TOPIC_IDENTITY_REMOVED, userContextId);
    return true;
  },

  _notify(topic, userContextId) {
    Services.obs.notifyObservers(null, topic, String(userContextId));
  },

  _save() {
    this._getStore().saveSoon();
  },

  _getStore() {
    if (this._store) {
      return this._store;
    }

    let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
    file.append(CONTAINERS_FILE);

    this._store = new JSONFile({
      path: file.path,
      dataPostProcessor: data => this._dataPostProcessor(data),
    });
    this._store.ensureDataReady();
    return this._store;
  },

  _dataPostProcessor(data) {
    if (!data || typeof data != "object") {
      data = {};
    }

    if (!Array.isArray(data.identities)) {
      data.identities = [];
    }

    if (typeof data.lastUserContextId != "number") {
      data.lastUserContextId = 0;
    }

    if (!data.identities.length) {
      data.identities = DEFAULT_IDENTITIES.map(identity => ({
        userContextId: identity.userContextId,
        name: getString(identity.nameKey),
        icon: identity.icon,
        color: identity.color,
      }));
      data.lastUserContextId = data.identities[data.identities.length - 1].userContextId;
    }

    let maxId = data.identities.reduce((max, identity) => {
      return Math.max(max, identity.userContextId);
    }, 0);
    if (data.lastUserContextId < maxId) {
      data.lastUserContextId = maxId;
    }

    data.version = CONTAINERS_VERSION;
    return data;
  },
};

