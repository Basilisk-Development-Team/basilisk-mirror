/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let gDecoderDoctorHandler = {
  getLabelForNotificationBox(type) {
    if (type == "platform-decoder-not-found") {
#ifdef XP_WIN
      return gNavigatorBundle.getString("decoder.noHWAcceleration.message");
#endif
#ifdef XP_LINUX
      return gNavigatorBundle.getString("decoder.noCodecsLinux.message");
#endif
    }
#if defined(XP_UNIX) && !defined(XP_MACOSX)
    if (type == "cannot-initialize-pulseaudio") {
      return gNavigatorBundle.getString("decoder.noPulseAudio.message");
    }
#endif
#if defined(XP_UNIX) && !defined(XP_MACOSX)
    if (type == "unsupported-libavcodec") {
      return gNavigatorBundle.getString("decoder.unsupportedLibavcodec.message");
    }
#endif
    return "";
  },

  getSumoForLearnHowButton(type) {
#if defined(XP_WIN)
    return "fix-video-audio-problems-firefox-windows";
#else
    if (type == "cannot-initialize-pulseaudio") {
      return "fix-common-audio-and-video-issues";
    }
    return "";
#endif
  },

  receiveMessage({target: browser, data: data}) {
    let box = gBrowser.getNotificationBox(browser);
    let notificationId = "decoder-doctor-notification";
    if (box.getNotificationWithValue(notificationId)) {
      return;
    }

    let parsedData;
    try {
      parsedData = JSON.parse(data);
    } catch (ex) {
      Cu.reportError("Malformed Decoder Doctor message with data: " + data);
      return;
    }
    // parsedData (the result of parsing the incoming 'data' json string)
    // contains analysis information from Decoder Doctor:
    // - 'type' is the type of issue, it determines which text to show in the
    //   infobar.
    // - 'decoderDoctorReportId' is the Decoder Doctor issue identifier, to be
    //   used here as key for the prefs used to store at-issue formats.
    // - 'formats' contains a comma-separated list of formats (or key systems)
    //   that suffer the issue. These are kept in a pref, which the backend
    //   uses to later find when an issue is resolved.
    // - 'isSolved' is true when the notification actually indicates the
    //   resolution of that issue.
    let {type, isSolved, decoderDoctorReportId, formats} = parsedData;
    type = type.toLowerCase();
    // Error out early on invalid ReportId
    if (!(/^\w+$/mi).test(decoderDoctorReportId)) {
      return
    }
    let title = gDecoderDoctorHandler.getLabelForNotificationBox(type);
    if (!title) {
      return;
    }

    // We keep the list of formats in prefs for the sake of the decoder itself,
    // which reads it to determine when issues get solved for these formats.
    let formatsPref = "media.decoder-doctor." + decoderDoctorReportId + ".formats";
    let buttonClickedPref = "media.decoder-doctor." + decoderDoctorReportId + ".button-clicked";
    let formatsInPref = Services.prefs.getPrefType(formatsPref) &&
                        Services.prefs.getCharPref(formatsPref);

    if (!isSolved) {
      if (!formats) {
        Cu.reportError("Malformed Decoder Doctor unsolved message with no formats");
        return;
      }
      if (!formatsInPref) {
        Services.prefs.setCharPref(formatsPref, formats);
      } else {
        // Split existing formats into an array of strings.
        let existing = formatsInPref.split(",").map(String.trim);
        // Keep given formats that were not already recorded.
        let newbies = formats.split(",").map(String.trim)
                      .filter(x => !existing.includes(x));
        // And rewrite pref with the added new formats (if any).
        if (newbies.length) {
          Services.prefs.setCharPref(formatsPref,
                                     existing.concat(newbies).join(", "));
        }
      }

      let buttons = [];
      let sumo = gDecoderDoctorHandler.getSumoForLearnHowButton(type);
      if (sumo) {
        buttons.push({
          label: gNavigatorBundle.getString("decoder.noCodecs.button"),
          accessKey: gNavigatorBundle.getString("decoder.noCodecs.accesskey"),
          callback() {
            let clickedInPref = Services.prefs.getPrefType(buttonClickedPref) &&
                                Services.prefs.getBoolPref(buttonClickedPref);
            if (!clickedInPref) {
              Services.prefs.setBoolPref(buttonClickedPref, true);
            }

            let baseURL = Services.urlFormatter.formatURLPref("app.support.baseURL");
            openUILinkIn(baseURL + sumo, "tab");
          }
        });
      }

      box.appendNotification(
          title,
          notificationId,
          "", // This uses the info icon as specified below.
          box.PRIORITY_INFO_LOW,
          buttons
      );
    } else if (formatsInPref) {
      // Issue is solved, and prefs haven't been cleared yet, meaning it's the
      // first time we get this resolution -> Clear prefs.
      Services.prefs.clearUserPref(formatsPref);
      Services.prefs.clearUserPref(buttonClickedPref);
    }
  },
}

window.getGroupMessageManager("browsers").addMessageListener("DecoderDoctor:Notification", gDecoderDoctorHandler);
window.addEventListener("unload", function() {
  window.getGroupMessageManager("browsers").removeMessageListener("DecoderDoctor:Notification", gDecoderDoctorHandler);
}, false);
