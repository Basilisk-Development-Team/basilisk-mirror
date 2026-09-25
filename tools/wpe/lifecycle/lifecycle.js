/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
const Cc = Components.classes, Ci = Components.interfaces, Cu = Components.utils;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
let view, cycle = 0, phase = 0, ticks = 0, messages = 0;
let timer, previousTitle, stoppedAt;
const base = "http://127.0.0.1:" +
  Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch)
    .getIntPref("wpe.test.port") + "/";
function finish(ok, reason) {
  clearInterval(timer);
  if (view) view.destroy();
  view = null;
  dump("WPE-LIFECYCLE " + (ok ? "PASS " : "FAIL ") + reason + "\n");
  Cc["@mozilla.org/toolkit/app-startup;1"].getService(Ci.nsIAppStartup).quit(Ci.nsIAppStartup.eForceQuit);
}
const listener = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),
  observe(subject, topic) {
    if (topic == "content-view-state") ++messages;
    if (topic == "content-view-process-terminated") finish(false, "web process terminated");
  }
};
function create() {
  view = Cc["@basilisk-browser.org/web-content-view/wpe;1"].createInstance(Ci.nsIWebContentView);
  view.attach(window, listener);
  view.setBounds(0, 35, 640, 450);
  view.setVisible(true);
  view.loadURI(base + "a");
  phase = 0;
}
window.addEventListener("load", function() {
  try {
    create();
    timer = setInterval(function() {
      try {
        if (++ticks > 720) return finish(false, "timeout at cycle " + cycle + " phase " + phase);
        let title = view.title, uri = view.currentURI;
        switch (phase) {
          case 0:
            if (title.indexOf("Page A") != 0 || uri != base + "a") return;
            view.loadURI(base + "b"); ++phase; break;
          case 1:
            if (title.indexOf("Page B") != 0 || !view.canGoBack || uri != base + "b") return;
            view.goBack(); ++phase; break;
          case 2:
            if (title.indexOf("Page A") != 0 || !view.canGoForward || uri != base + "a") return;
            view.goForward(); ++phase; break;
          case 3:
            if (title.indexOf("Page B") != 0 || uri != base + "b") return;
            previousTitle = title; view.reload(); ++phase; break;
          case 4:
            if (title.indexOf("Page B") != 0 || title == previousTitle) return;
            view.loadURI(base + "slow"); ++phase; break;
          case 5:
            view.stop(); stoppedAt = ticks; ++phase; break;
          case 6:
            if (ticks - stoppedAt < 12) return;
            if (title.indexOf("Page Slow") == 0) return finish(false, "stop did not cancel delayed navigation");
            view.focus(); view.setVisible(false); view.setVisible(true);
            view.destroy(); view.destroy(); view = null;
            dump("WPE-LIFECYCLE cycle " + (++cycle) + " notifications " + messages + "\n");
            if (cycle == 10) return finish(true, "navigation/title/URI and ten attach/destroy cycles");
            create(); break;
        }
      } catch (e) { finish(false, String(e)); }
    }, 250);
  } catch (e) { finish(false, String(e)); }
});
window.addEventListener("unload", function() { if (view) view.destroy(); });
