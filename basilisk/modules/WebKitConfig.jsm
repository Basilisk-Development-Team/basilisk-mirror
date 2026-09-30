/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
this.EXPORTED_SYMBOLS = ["WebKitConfig"];
Components.utils.import("resource://gre/modules/Services.jsm");

var WebKitConfig = {
  get enabled() { return Services.prefs.getBoolPref("webkit.enabled"); },

  bindWindow(window) {
    const update = () => {
      const enabled = this.enabled;
      for (const element of window.document.querySelectorAll("[webkit-feature]")) {
        element.hidden = !enabled;
        const note = element.getAttribute("webkit-cookie-note");
        if (note) {
          element.textContent = enabled ? Services.strings.createBundle(
            "chrome://browser/locale/webkit.properties").GetStringFromName("cookies." + note) : "";
        }
      }
      window.dispatchEvent(new window.CustomEvent("WebKitEnabledChanged"));
    };
    const observer = { observe: update };
    Services.prefs.addObserver("webkit.enabled", observer, false);
    window.addEventListener("load", update, {once: true});
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver("webkit.enabled", observer);
    }, {once: true});
  }
};
