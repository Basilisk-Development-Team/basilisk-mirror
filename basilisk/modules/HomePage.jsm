/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["HomePage"];

const STORAGE_SEPARATOR = "|";
const DISPLAY_SEPARATOR = " | ";

var HomePage = {
  getURLs: function (aValue)
  {
    if (aValue == "")
      return [""];

    if (!aValue)
      return [];

    if (!aValue.includes(STORAGE_SEPARATOR))
      return [aValue];

    let urls = this._splitOnPipe(aValue);
    if (this._looksLikeSingleURLWithLiteralPipe(urls))
      return [aValue];

    return urls;
  },

  getFirstURL: function (aValue)
  {
    let urls = this.getURLs(aValue);
    return urls.length ? urls[0] : "";
  },

  getPrefValueFromURLs: function (aURLs)
  {
    if (!aURLs || !aURLs.length)
      return "";

    return aURLs.map(this._encodeURL, this).join(STORAGE_SEPARATOR);
  },

  getPrefValueFromInput: function (aValue)
  {
    return this.getPrefValueFromURLs(this._getURLsFromInput(aValue));
  },

  getDisplayValue: function (aValue)
  {
    if (aValue == "")
      return "";

    return this.getURLs(aValue)
               .map(this._decodeURLForDisplay, this)
               .join(DISPLAY_SEPARATOR);
  },

  _splitOnPipe: function (aValue)
  {
    return aValue.split(STORAGE_SEPARATOR).map(function(aURL) {
      return aURL.trim();
    });
  },

  _encodeURL: function (aURL)
  {
    return aURL.replace(/\|/g, "%7C");
  },

  _decodeURLForDisplay: function (aURL)
  {
    return aURL.replace(/%7C/ig, "|");
  },

  _getURLsFromInput: function (aValue)
  {
    if (aValue == "")
      return [""];

    let value = aValue.replace(/\r\n?/g, "\n");

    if (value.includes("\n"))
      return this._cleanURLs(value.split(/\n+/));

    if (/\s\||\|\s/.test(value))
      return this._cleanURLs(value.split(/\s*\|\s*/));

    if (value.includes(STORAGE_SEPARATOR)) {
      let urls = this._splitOnPipe(value);
      if (!this._looksLikeSingleURLWithLiteralPipe(urls))
        return urls;
    }

    return [value];
  },

  _cleanURLs: function (aURLs)
  {
    let urls = aURLs.map(function(aURL) {
      return aURL.trim();
    }).filter(function(aURL) {
      return aURL;
    });

    return urls.length ? urls : [""];
  },

  _looksLikeSingleURLWithLiteralPipe: function (aURLs)
  {
    if (aURLs.length <= 1)
      return false;

    let looksLikeURL = aURLs.map(this._looksLikeURL, this);
    return looksLikeURL.some(function(aValue) {
      return aValue;
    }) && looksLikeURL.some(function(aValue) {
      return !aValue;
    });
  },

  _looksLikeURL: function (aValue)
  {
    return /^(?:[a-z][a-z0-9+.-]*:[^\s]*|[^\/\s]+\.[^\s]+(?:[\/:?#].*)?|localhost(?:[\/:?#].*)?)$/i.test(aValue);
  },
};
