/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
let contentView = null;
let closing = false;
let contextLink = "";
const element = id => document.getElementById(id);

function reportError(error) {
  element("status").value = "alternate content error: " + error;
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
  let scale = window.devicePixelRatio;
  contentView.setBounds(Math.round(rect.left * scale), Math.round(rect.top * scale),
                        Math.round(rect.width * scale), Math.round(rect.height * scale));
  contentView.setVisible(true);
}
const listener = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),
  observe(subject, topic, data) {
    if (closing || !contentView) return;
    if (topic == "content-view-process-terminated") {
      element("status").value = "The alternate content web process terminated. Reload to retry.";
      return;
    }
    if (topic == "content-view-context-menu") {
      let info = subject.QueryInterface(Ci.nsIPropertyBag2);
      contextLink = info.getPropertyAsAUTF8String("linkURL");
      element("context-back").disabled = !contentView.canGoBack;
      element("context-forward").disabled = !contentView.canGoForward;
      element("context-link").hidden = !info.getPropertyAsBool("isLink");
      let rect = element("content-host").getBoundingClientRect();
      element("content-menu").openPopupAtScreen(
        window.mozInnerScreenX + rect.left + info.getPropertyAsInt32("x") / window.devicePixelRatio,
        window.mozInnerScreenY + rect.top + info.getPropertyAsInt32("y") / window.devicePixelRatio, true);
      return;
    }
    if (topic != "content-view-state") return;
    element("location").value = contentView.currentURI;
    document.title = (contentView.title || "alternate content content view") + " — alternate content experiment";
    element("back").disabled = !contentView.canGoBack;
    element("forward").disabled = !contentView.canGoForward;
  }
};
window.addEventListener("load", function() {
  try {
    contentView = Cc["@basilisk-browser.org/content-view;1?engine=webkit"]
                    .createInstance(Ci.nsIWebContentView);
    contentView.attach(window, listener);
    for (let [id, method] of [["back", "goBack"], ["forward", "goForward"],
                              ["reload", "reload"], ["stop", "stop"]])
      element(id).addEventListener("command", () => invoke(method));
    for (let [id, method] of [["context-back", "goBack"],
                              ["context-forward", "goForward"], ["context-reload", "reload"]])
      element(id).addEventListener("command", () => invoke(method));
    element("context-link").addEventListener("command", () => {
      try { contentView.loadURI(contextLink); } catch (error) { reportError(error); }
    });
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
