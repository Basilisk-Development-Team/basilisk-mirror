/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// WPE owns the transfer. XUL chooses the destination and records completion in
// the existing download list; never restart the request through Gecko.
var ContentEngineDownloads = {
  observe(view, topic, info) {
    if (topic == "content-view-download-request") {
      view.native.blur();
      let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      let strings = Services.strings.createBundle("chrome://global/locale/contentAreaCommands.properties");
      picker.init(window, strings.GetStringFromName("SaveLinkTitle"), Ci.nsIFilePicker.modeSave);
      picker.defaultString = info.getPropertyAsAUTF8String("filename").replace(/[\\/]/g, "_");
      let result = picker.show();
      if (!view.destroyed && (result == Ci.nsIFilePicker.returnOK || result == Ci.nsIFilePicker.returnReplace))
        info.setPropertyAsAUTF8String("path", picker.file.path);
      return;
    }
    let path = info.getPropertyAsAUTF8String("path");
    let error = info.getPropertyAsAUTF8String("error");
    if (!path) return; // Cancelled before a destination was chosen.
    if (error) {
      let box = gBrowser.getNotificationBox(view.browser);
      box.appendNotification(error, "content-download-error", null, box.PRIORITY_WARNING_MEDIUM, []);
      return;
    }
    let scope = {};
    Cu.import("resource://gre/modules/Downloads.jsm", scope);
    let isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
    scope.Downloads.createDownload({
      source: {url: info.getPropertyAsAUTF8String("uri"), isPrivate},
      target: path, succeeded: true, stopped: true, startTime: new Date()
    }).then(download => {
      download.progress = 100;
      return download.refresh().then(() => scope.Downloads.getList(
        isPrivate ? scope.Downloads.PRIVATE : scope.Downloads.PUBLIC))
        .then(list => list.add(download));
    }).then(() => { if (!window.closed) DownloadsPanel.showPanel(); }, Cu.reportError);
  }
};
