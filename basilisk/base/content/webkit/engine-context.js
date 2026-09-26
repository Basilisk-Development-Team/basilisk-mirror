/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
"use strict";

// Reuse the existing contentAreaContextMenu markup and command identities.
// This adapter consumes primitive hit-test data; it never calls Gecko DOM menu
// helpers on a WebKit document. Restore menu state before the next Gecko popup.
var ContentEngineContext = {
  pending: null,
  active: null,
  open(view, info) {
    this.pending = {view, info};
    let rect = view.browser.getBoundingClientRect();
    document.getElementById("contentAreaContextMenu").openPopupAtScreen(
      window.mozInnerScreenX + rect.left + info.getPropertyAsInt32("x") / window.devicePixelRatio,
      window.mozInnerScreenY + rect.top + info.getPropertyAsInt32("y") / window.devicePixelRatio, true);
    this.pending = null;
  },
  create(menu) {
    let {view, info} = this.pending;
    this.active = view;
    let link = info.getPropertyAsAUTF8String("linkURL");
    let isLink = info.getPropertyAsBool("isLink");
    let editable = info.getPropertyAsBool("isEditable");
    let selection = info.getPropertyAsBool("hasSelection");
    let visible = new Set(["context-navigation", "context-sep-navigation", "context-selectall"]);
    if (isLink) for (let id of ["context-openlink", "context-openlinkintab", "context-openlinkincurrent", "context-copylink"])
      visible.add(id);
    if (selection || editable) visible.add("context-copy");
    if (editable) { visible.add("context-cut"); visible.add("context-paste"); }
    let saved = [];
    for (let item of menu.children) {
      if (!/^(context-|spell-|frame|open-frame-|fill-login|saved-logins-|inspect-)/.test(item.id) &&
          item.id != "page-menu-separator") continue;
      saved.push([item, item.hidden]);
      item.hidden = !visible.has(item.id);
    }
    document.getElementById("context-bookmarkpage").hidden = true;
    return {
      shouldDisplay: true,
      browser: view.browser,
      reload() { view.native.reload(); },
      openLinkInCurrent() { view.loadURI(link); },
      openLinkInTab() { ContentEngines.open(link); },
      openLink() {
        // Use Basilisk's window creation, then its content adapter after startup.
        let win = OpenBrowserWindow();
        let observer = function(subject, topic) {
          if (subject != win) return;
          Services.obs.removeObserver(observer, topic);
          let initial = win.gBrowser.selectedTab;
          win.ContentEngines.open(link);
          win.gBrowser.removeTab(initial, {animate: false});
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished", false);
      },
      copyLink() {
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(link);
      },
      hiding() {
        for (let [item, hidden] of saved) item.hidden = hidden;
        document.getElementById("context-bookmarkpage").hidden = false;
        ContentEngineContext.active = null;
      }
    };
  }
};

var ContentEngineEditController = {
  commands: {cmd_copy: "copy", cmd_cut: "cut", cmd_paste: "paste", cmd_selectAll: "selectAll"},
  get view() {
    let view = ContentEngineContext.active || ContentEngines.get();
    return view && (ContentEngineContext.active || view.native.focused) ? view : null;
  },
  supportsCommand(command) { return !!this.commands[command] && !!this.view; },
  isCommandEnabled(command) { return this.supportsCommand(command); },
  doCommand(command) { let view = this.view; if (view) view.native.edit(this.commands[command]); },
  onEvent() {},
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIController])
};

