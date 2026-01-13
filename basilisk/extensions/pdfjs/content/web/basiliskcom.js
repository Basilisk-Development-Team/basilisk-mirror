// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
(function () {
  "use strict";

  if (!window.PDFViewerApplication || !window.PDFViewerApplicationOptions ||
      !window.pdfjsLib) {
    return;
  }

  var pdfjsLib = window.pdfjsLib;
  var BaseExternalServices = window.PDFViewerApplication.externalServices;

  var FirefoxCom = function FirefoxComClosure() {
    return {
      requestSync: function (action, data) {
        var request = document.createTextNode("");
        document.documentElement.appendChild(request);
        var sender = document.createEvent("CustomEvent");
        sender.initCustomEvent("pdf.js.message", true, false, {
          action: action,
          data: data,
          sync: true
        });
        request.dispatchEvent(sender);
        var response = sender.detail.response;
        document.documentElement.removeChild(request);
        return response;
      },

      request: function (action, data, callback) {
        var request = document.createTextNode("");

        if (callback) {
          document.addEventListener("pdf.js.response", function listener(event) {
            var node = event.target;
            var response = event.detail.response;
            document.documentElement.removeChild(node);
            document.removeEventListener("pdf.js.response", listener);
            return callback(response);
          });
        }

        document.documentElement.appendChild(request);
        var sender = document.createEvent("CustomEvent");
        sender.initCustomEvent("pdf.js.message", true, false, {
          action: action,
          data: data,
          sync: false,
          responseExpected: !!callback
        });
        return request.dispatchEvent(sender);
      }
    };
  }();

  class FirefoxComDataRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    constructor(length, initialData, progressiveDone) {
      super(length, initialData, progressiveDone);
    }

    requestDataRange(begin, end) {
      FirefoxCom.request("requestDataRange", {
        begin: begin,
        end: end
      });
    }

    abort() {
      FirefoxCom.requestSync("abortLoading", null);
    }
  }

  function getShadowedValue(name, value) {
    if (typeof pdfjsLib.shadow === "function") {
      return pdfjsLib.shadow(BaseExternalServices, name, value);
    }
    return value;
  }

  class BasiliskExternalServices extends BaseExternalServices {
    static updateFindControlState(data) {
      FirefoxCom.request("updateFindControlState", data);
    }

    static updateFindMatchesCount(data) {
      FirefoxCom.request("updateFindMatchesCount", data);
    }

    static updateEditorStates(data) {
      // No-op: avoid throwing in DefaultExternalServices.
    }

    static reportTelemetry(data) {
      // No-op for Basilisk.
    }

    static initPassiveLoading(callbacks) {
      var pdfDataRangeTransport = null;

      window.addEventListener("message", function windowMessage(event) {
        if (event.source !== null) {
          return;
        }

        var args = event.data;
        if (!args || typeof args !== "object" || !("pdfjsLoadAction" in args)) {
          return;
        }

        switch (args.pdfjsLoadAction) {
          case "supportsRangedLoading":
            if (args.data && !args.rangeEnabled && !args.streamingEnabled) {
              callbacks.onOpenWithData(args.data);
              break;
            }
            pdfDataRangeTransport = new FirefoxComDataRangeTransport(
              args.length,
              args.data
            );
            callbacks.onOpenWithTransport(args.pdfUrl, args.length, pdfDataRangeTransport);
            break;
          case "range":
            if (pdfDataRangeTransport) {
              pdfDataRangeTransport.onDataRange(args.begin, args.chunk);
            }
            break;
          case "rangeProgress":
            if (pdfDataRangeTransport) {
              pdfDataRangeTransport.onDataProgress(args.loaded);
            }
            break;
          case "progressiveRead":
            if (pdfDataRangeTransport) {
              pdfDataRangeTransport.onDataProgressiveRead(args.chunk);
              pdfDataRangeTransport.onDataProgress(args.loaded, args.total);
            }
            break;
          case "progress":
            callbacks.onProgress(args.loaded, args.total);
            break;
          case "complete":
            if (!args.data) {
              callbacks.onError(args.errorCode);
              break;
            }
            callbacks.onOpenWithData(args.data);
            break;
        }
      });

      FirefoxCom.requestSync("initPassiveLoading", null);
    }

    static get supportsIntegratedFind() {
      var support = false;
      try {
        support = FirefoxCom.requestSync("supportsIntegratedFind", null);
      } catch (e) {}
      return getShadowedValue("supportsIntegratedFind", support);
    }

    static get supportsDocumentFonts() {
      var support = true;
      try {
        support = FirefoxCom.requestSync("supportsDocumentFonts", null);
      } catch (e) {}
      return getShadowedValue("supportsDocumentFonts", support);
    }

    static get supportedMouseWheelZoomModifierKeys() {
      var support = {
        ctrlKey: true,
        metaKey: true
      };
      try {
        support = FirefoxCom.requestSync("supportedMouseWheelZoomModifierKeys", null);
      } catch (e) {}
      return getShadowedValue("supportedMouseWheelZoomModifierKeys", support);
    }
  }

  window.PDFViewerApplication.externalServices = BasiliskExternalServices;

  window.PDFViewerApplication.initPassiveLoading = function () {
    var self = this;
    this.externalServices.initPassiveLoading({
      onOpenWithTransport: function (url, length, transport) {
        self.open({
          url: url,
          originalUrl: url,
          length: length,
          range: transport
        });
      },
      onOpenWithData: function (data) {
        self.open({
          data: data
        });
      },
      onOpenWithURL: function (url, length, originalUrl) {
        var args = {
          url: url
        };
        if (originalUrl) {
          args.originalUrl = originalUrl;
        }
        if (length !== undefined) {
          args.length = length;
        }
        self.open(args);
      },
      onError: function (err) {
        self.l10n.get("loading_error").then(function (msg) {
          self._documentError(msg, {
            message: err && err.message ? err.message : err
          });
        });
      },
      onProgress: function (loaded, total) {
        self.progress(loaded / total);
      }
    });
  };

  function wireSidebarButtons() {
    var app = window.PDFViewerApplication;
    if (!app || !app.pdfSidebar) {
      return;
    }
    var buttonIds = ["viewThumbnail", "viewOutline", "viewAttachments", "viewLayers"];
    for (var i = 0; i < buttonIds.length; i++) {
      var button = document.getElementById(buttonIds[i]);
      if (!button) {
        continue;
      }
      button.addEventListener("click", function () {
        if (!app.pdfSidebar.isOpen) {
          app.pdfSidebar.open();
        }
      });
    }
  }

  var originalOpen = window.PDFViewerApplication.open;
  window.PDFViewerApplication.open = function (args) {
    var nextArgs = null;
    if (typeof args === "string") {
      nextArgs = { url: args };
    } else if (args && args.byteLength) {
      nextArgs = { data: args };
    } else if (args && typeof args === "object") {
      nextArgs = Object.assign({}, args);
    } else {
      nextArgs = {};
    }
    nextArgs.isEvalSupported = false;
    nextArgs.enableScripting = false;
    nextArgs.enableXfa = false;
    return originalOpen.call(this, nextArgs);
  };

  var originalRun = window.PDFViewerApplication.run;
  window.PDFViewerApplication.run = async function (config) {
    window.PDFViewerApplicationOptions.set("defaultUrl", "");
    window.PDFViewerApplicationOptions.set("isEvalSupported", false);
    window.PDFViewerApplicationOptions.set("enableScripting", false);
    window.PDFViewerApplicationOptions.set("enableXfa", false);
    await originalRun.call(this, config);
    wireSidebarButtons();
    if (!/(?:^|[?&])file=/.test(document.location.search)) {
      this.initPassiveLoading();
    }
  };
})();
