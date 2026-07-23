"use strict";

var PdfjsContentUtils = Components.utils.import(
  "resource://pdf.js/PdfjsContentUtils.jsm", {}).PdfjsContentUtils;
var PdfJs = Components.utils.import("resource://pdf.js/PdfJs.jsm", {}).PdfJs;

PdfjsContentUtils.init();

if (PdfJs.enabled) {
  PdfJs.ensureRegistered();
}
