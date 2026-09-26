/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentEngineDevTools = {
  open(browser = gBrowser.selectedBrowser) {
    let view = ContentEngines.get(browser);
    if (!view) return gDevToolsBrowser.toggleToolboxCommand(gBrowser);
    if (PrivateBrowsingUtils.isWindowPrivate(window)) {
      let box = gBrowser.getNotificationBox(browser);
      if (!box.getNotificationWithValue("wpe-private-inspector"))
        box.appendNotification("WebKit Inspector is unavailable in private windows because upstream Inspector storage is persistent.",
          "wpe-private-inspector", null, box.PRIORITY_INFO_MEDIUM, []);
      return;
    }
    view.native.openDeveloperTools();
  }
};
window.addEventListener("command", event => {
  if (!ContentEngines.get()) return;
  let id = event.target.id || "";
  if (["menu_devToolbox", "key_devToolboxMenuItem", "key_devToolboxMenuItemF12"].includes(id) ||
      /^(menuitem_|appmenuitem_|key_)(inspector|webconsole|jsdebugger|styleeditor|netmonitor|storage)$/.test(id)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ContentEngineDevTools.open();
  }
}, true);
