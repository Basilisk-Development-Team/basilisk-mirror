/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
let contentView = null;
let closing = false;
const element = id => document.getElementById(id);

function reportError(error) {
  element("status").value = "WPE error: " + error;
  Cu.reportError(error);
}
function invoke(method) {
  try { contentView[method](); } catch (error) { reportError(error); }
}
function loadLocation() {
  try {
    contentView.loadURI(element("location").value.trim());
    contentView.focus();
  } catch (error) { reportError(error); }
}
function updateBounds() {
  if (!contentView || closing) return;
  let rect = element("content-host").getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    contentView.setVisible(false);
    return;
  }
  contentView.setBounds(Math.round(rect.left), Math.round(rect.top),
                        Math.round(rect.width), Math.round(rect.height));
  contentView.setVisible(true);
}
const listener = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),
  observe(subject, topic, data) {
    if (closing || !contentView) return;
    if (topic == "content-view-process-terminated") {
      element("status").value = "The WPE web process terminated. Reload to retry.";
      return;
    }
    if (topic != "content-view-state") return;
    element("location").value = contentView.currentURI;
    document.title = (contentView.title || "WPE content view") + " — WPE experiment";
    element("back").disabled = !contentView.canGoBack;
    element("forward").disabled = !contentView.canGoForward;
  }
};
window.addEventListener("load", function() {
  try {
    contentView = Cc["@basilisk-browser.org/web-content-view/wpe;1"]
                    .createInstance(Ci.nsIWebContentView);
    contentView.attach(window, listener);
    for (let [id, method] of [["back", "goBack"], ["forward", "goForward"],
                              ["reload", "reload"], ["stop", "stop"]])
      element(id).addEventListener("command", () => invoke(method));
    element("go").addEventListener("command", loadLocation);
    element("location").addEventListener("keypress", event => {
      if (event.keyCode == event.DOM_VK_RETURN) loadLocation();
    });
    window.requestAnimationFrame(() => {
      if (closing) return;
      try { updateBounds(); loadLocation(); } catch (error) { reportError(error); }
    });
    window.addEventListener("resize", updateBounds);
  } catch (error) {
    if (contentView) contentView.destroy();
    contentView = null;
    reportError(error);
  }
});
window.addEventListener("unload", function() {
  closing = true;
  window.removeEventListener("resize", updateBounds);
  if (contentView) contentView.destroy();
  contentView = null;
});
