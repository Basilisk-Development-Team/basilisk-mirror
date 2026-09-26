/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentEngineFullscreen = {
  view: null,
  enter(view) {
    if (this.view == view) return;
    this.exit();
    if (view.browser != gBrowser.selectedBrowser) {
      // Complete then exit WPE's entering transition without changing chrome.
      view.native.setFullscreen(true);
      view.native.setFullscreen(false);
      return;
    }
    this.view = view;
    this.wasFullscreen = window.fullScreen;
    window.fullScreen = true;
    // A native child clips XUL overlays. Use the ordinary notification area,
    // outside the content rectangle, so exit UI cannot be hidden by the page.
    let box = gBrowser.getNotificationBox(view.browser);
    this.notice = box.appendNotification("Full screen — press Esc to exit", "content-fullscreen", null,
      box.PRIORITY_INFO_LOW, [{label: "Exit Full Screen", accessKey: "E", callback: () => { this.exit(); return true; }}]);
    view.native.setFullscreen(true);
    ContentEngines.layout();
  },
  exit() {
    let view = this.view;
    if (!view) return;
    this.view = null;
    if (this.notice && this.notice.parentNode) this.notice.close();
    this.notice = null;
    if (!view.destroyed) view.native.setFullscreen(false);
    window.fullScreen = this.wasFullscreen;
    ContentEngines.layout();
  }
};
window.addEventListener("keydown", event => {
  if (event.key == "Escape" && ContentEngineFullscreen.view) {
    event.preventDefault(); ContentEngineFullscreen.exit();
  }
}, true);
window.addEventListener("fullscreen", () => {
  if (!window.fullScreen) ContentEngineFullscreen.exit();
});
