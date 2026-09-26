/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const view = window.arguments[0].QueryInterface(Components.interfaces.nsIWebContentView);
let mounted = false;
function layout() {
  if (!mounted) return;
  let scale = window.devicePixelRatio;
  view.setBounds(0, 0, Math.max(1, Math.round(innerWidth * scale)), Math.max(1, Math.round(innerHeight * scale)));
}
window.addEventListener("load", () => {
  view.attach(window, {observe(subject, topic) { if (topic == "content-view-closed") window.close(); }});
  mounted = true;
  layout();
  view.setVisible(true);
  view.focus();
});
window.addEventListener("resize", layout);
window.addEventListener("unload", () => { mounted = false; view.destroy(); });
