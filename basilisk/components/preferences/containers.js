/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource:///modules/ContextualIdentityService.jsm");

var gContainers = {
  _list: null,
  _name: null,
  _icon: null,
  _color: null,
  _saveButton: null,
  _removeButton: null,
  _bundle: null,
  _icons: null,
  _colors: null,
  _editingId: null,

  onLoad() {
    this._list = document.getElementById("containersList");
    this._name = document.getElementById("containerName");
    this._icon = document.getElementById("containerIcon");
    this._color = document.getElementById("containerColor");
    this._saveButton = document.getElementById("saveContainer");
    this._removeButton = document.getElementById("removeContainer");
    this._bundle = Services.strings.createBundle("chrome://browser/locale/containers.properties");

    this._icons = ContextualIdentityService.getAvailableIcons();
    this._colors = ContextualIdentityService.getAvailableColors();

    this._populateIconList();
    this._populateColorList();
    this._reloadContainers();

    Services.obs.addObserver(this, "contextual-identity-added", false);
    Services.obs.addObserver(this, "contextual-identity-updated", false);
    Services.obs.addObserver(this, "contextual-identity-removed", false);
  },

  onUnload() {
    Services.obs.removeObserver(this, "contextual-identity-added");
    Services.obs.removeObserver(this, "contextual-identity-updated");
    Services.obs.removeObserver(this, "contextual-identity-removed");
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "contextual-identity-added":
      case "contextual-identity-updated":
      case "contextual-identity-removed":
        this._reloadContainers(this._editingId);
        break;
    }
  },

  _populateIconList() {
    let popup = document.getElementById("containerIconPopup");
    while (popup.firstChild) {
      popup.firstChild.remove();
    }

    for (let icon of this._icons) {
      let item = document.createElement("menuitem");
      item.setAttribute("value", icon);
      item.setAttribute("label", ContextualIdentityService.getIconLabel(icon));
      item.setAttribute("class", "menuitem-iconic usercontext-icon-item");
      item.setAttribute("image", "chrome://browser/content/usercontext.svg#" + icon);
      popup.appendChild(item);
    }
  },

  _populateColorList() {
    let popup = document.getElementById("containerColorPopup");
    while (popup.firstChild) {
      popup.firstChild.remove();
    }

    for (let color of this._colors) {
      let item = document.createElement("menuitem");
      item.setAttribute("value", color);
      item.setAttribute("label", ContextualIdentityService.getColorLabel(color));
      item.setAttribute("class", "menuitem-iconic usercontext-color-item");
      item.setAttribute("usercontextcolor", color);
      item.setAttribute("image", "chrome://browser/content/usercontext.svg#circle");
      item.style.setProperty("--usercontext-color",
                             ContextualIdentityService.getColorCode(color));
      popup.appendChild(item);
    }
  },

  _reloadContainers(selectedId) {
    let currentId = selectedId || this._getSelectedUserContextId();

    while (this._list.firstChild) {
      this._list.firstChild.remove();
    }

    for (let identity of ContextualIdentityService.getPublicIdentities()) {
      this._list.appendChild(this._createItem(identity));
    }

    if (currentId) {
      this._selectContainerById(currentId);
    }

    if (!this._list.selectedItem && this._list.itemCount) {
      this._list.selectedIndex = 0;
    }

    this._syncFields();
  },

  _getSelectedUserContextId() {
    let item = this._list.selectedItem;
    if (!item || !item._identity) {
      return 0;
    }
    return item._identity.userContextId;
  },

  _selectContainerById(userContextId) {
    for (let item of this._list.children) {
      if (item._identity && item._identity.userContextId == userContextId) {
        this._list.selectedItem = item;
        return true;
      }
    }
    return false;
  },

  _createItem(identity) {
    let item = document.createElement("richlistitem");
    item.className = "usercontext-item";
    item.setAttribute("usercontextid", identity.userContextId);
    item.style.setProperty("--usercontext-color",
                           ContextualIdentityService.getColorCode(identity.color));

    let hbox = document.createElement("hbox");
    hbox.setAttribute("align", "center");

    let icon = document.createElement("image");
    icon.className = "usercontext-icon";
    icon.setAttribute("src", "chrome://browser/content/usercontext.svg#" + identity.icon);

    let label = document.createElement("label");
    label.className = "usercontext-label";
    label.setAttribute("flex", "1");
    label.setAttribute("value", identity.name);

    hbox.appendChild(icon);
    hbox.appendChild(label);
    item.appendChild(hbox);

    item._identity = identity;
    item._icon = icon;
    item._label = label;
    return item;
  },

  _updateItem(item, identity) {
    item._identity = identity;
    item.setAttribute("usercontextid", identity.userContextId);
    item.style.setProperty("--usercontext-color",
                           ContextualIdentityService.getColorCode(identity.color));
    item._icon.setAttribute("src",
                            "chrome://browser/content/usercontext.svg#" + identity.icon);
    item._label.setAttribute("value", identity.name);
  },

  _syncFields() {
    let item = this._list.selectedItem;
    if (!item || !item._identity) {
      this._editingId = null;
      this._setDefaults();
      this._removeButton.disabled = true;
      this._updateSaveButtonState();
      return;
    }

    this._editingId = item._identity.userContextId;
    this._name.value = item._identity.name;
    this._icon.value = item._identity.icon;
    this._color.value = item._identity.color;
    this._updateColorPreview();
    this._removeButton.disabled = false;
    this._updateSaveButtonState();
  },

  _setDefaults() {
    this._name.value = "";
    this._icon.value = this._icons[0] || "circle";
    this._color.value = this._colors[0] || "blue";
    this._updateColorPreview();
  },

  _updateSaveButtonState() {
    let name = this._name.value.trim();
    this._saveButton.disabled = !name;
  },

  _updateColorPreview() {
    let color = this._color.value || "blue";
    this._color.setAttribute("usercontextcolor", color);
  },

  onInput() {
    this._updateColorPreview();
    this._updateSaveButtonState();
  },

  onSelect() {
    this._syncFields();
  },

  startNew() {
    this._list.clearSelection();
    this._editingId = null;
    this._setDefaults();
    this._removeButton.disabled = true;
    this._updateSaveButtonState();
    this._name.focus();
  },

  saveContainer() {
    let name = this._name.value.trim();
    if (!name) {
      this._updateSaveButtonState();
      return;
    }

    let icon = this._icon.value;
    let color = this._color.value;

    if (this._editingId) {
      let identity = ContextualIdentityService.updateIdentity(this._editingId,
                                                              { name, icon, color });
      if (identity) {
        let item = this._list.selectedItem;
        if (item && item._identity &&
            item._identity.userContextId == identity.userContextId) {
          this._updateItem(item, identity);
        } else {
          this._reloadContainers(identity.userContextId);
        }
      }
      return;
    }

    let identity = ContextualIdentityService.createIdentity(name, icon, color);
    this._reloadContainers(identity.userContextId);
  },

  removeContainer() {
    let item = this._list.selectedItem;
    if (!item || !item._identity) {
      return;
    }

    let userContextId = item._identity.userContextId;
    if (this._containerHasOpenTabs(userContextId)) {
      let title = this._bundle.getString("containers.remove.title");
      let message = this._bundle.getString("containers.remove.message");
      Services.prompt.alert(window, title, message);
      return;
    }

    ContextualIdentityService.removeIdentity(userContextId);
    this._reloadContainers();
  },

  _containerHasOpenTabs(userContextId) {
    let enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
      let win = enumerator.getNext();
      if (!win.gBrowser) {
        continue;
      }
      for (let tab of win.gBrowser.tabs) {
        let tabContext = parseInt(tab.getAttribute("usercontextid"), 10) || 0;
        if (tabContext == userContextId) {
          return true;
        }
      }
    }
    return false;
  },
};
