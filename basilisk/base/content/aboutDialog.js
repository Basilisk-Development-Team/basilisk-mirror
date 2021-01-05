/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Services = object with smart getters for common XPCOM services
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/AppConstants.jsm");

function init(aEvent)
{
  if (aEvent.target != document)
    return;

  try {
    var distroId = Services.prefs.getCharPref("distribution.id");
    if (distroId) {
      var distroVersion = Services.prefs.getCharPref("distribution.version");

      var distroIdField = document.getElementById("distributionId");
      distroIdField.value = distroId + " - " + distroVersion;
      distroIdField.style.display = "block";

      try {
        // This is in its own try catch due to bug 895473 and bug 900925.
        var distroAbout = Services.prefs.getComplexValue("distribution.about",
          Components.interfaces.nsISupportsString);
        var distroField = document.getElementById("distribution");
        distroField.value = distroAbout;
        distroField.style.display = "block";
      }
      catch (ex) {
        // Pref is unset
        Components.utils.reportError(ex);
      }
    }
  }
  catch (e) {
    // Pref is unset
  }

  // Include the build ID 
  let versionField = document.getElementById("version");
  let version = Services.appinfo.version;
  let buildID = Services.appinfo.appBuildID;
  let year = buildID.slice(0, 4);
  let month = buildID.slice(4, 6);
  let day = buildID.slice(6, 8);
  let hour = buildID.slice(8, 10);
  let minute = buildID.slice(10, 12);
  if (Services.prefs.getBoolPref("general.useragent.appVersionIsBuildID")) {
    versionField.textContent = `${year}.${month}.${day}`;
  } else {
    versionField.textContent = `v` + version + ` (${year}-${month}-${day})`;
  }
  
  // Display warning if this is an "a#" (nightly or aurora) build
  if (/a\d+$/.test(version)) {
    document.getElementById("experimental").hidden = false;
    document.getElementById("communityDesc").hidden = true;
  }

  // Get Release Notes URL from Preferences
  let releaseNotesURL = Services.prefs.getCharPref("app.releaseNotesURL");
  document.getElementById("releasenotes").setAttribute("href", releaseNotesURL);

  if (AppConstants.MOZ_UPDATER) {
    gAppUpdater = new appUpdater();

    let channelLabel = document.getElementById("currentChannel");
    let currentChannelText = document.getElementById("currentChannelText");
    channelLabel.value = UpdateUtils.UpdateChannel;
    if (/^release($|\-)/.test(channelLabel.value))
        currentChannelText.hidden = true;
  }

  if (AppConstants.platform == "macosx") {
    // it may not be sized at this point, and we need its width to calculate its position
    window.sizeToContent();
    window.moveTo((screen.availWidth / 2) - (window.outerWidth / 2), screen.availHeight / 5);
  }
}
