/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
"use strict";

// Adapter for the existing findbar's asynchronous listener protocol. Searches
// execute through the native engine, never by inspecting the empty shell DOM.
class ContentEngineFinder {
  constructor(view) {
    this.view = view;
    this.listeners = new Set();
    this.searchString = "";
    this.caseSensitive = false;
    this.clipboardSearchString = "";
  }
  addResultListener(listener) { this.listeners.add(listener); }
  removeResultListener(listener) { this.listeners.delete(listener); }
  fastFind(text) {
    this.searchString = text;
    if (text) this.view.native.find(text, false, this.caseSensitive);
    else this.view.native.clearFind();
  }
  findAgain(backwards) { this.view.native.findAgain(backwards); }
  result(found) {
    for (let listener of this.listeners) listener.onFindResult({
      result: found ? Ci.nsITypeAheadFind.FIND_FOUND : Ci.nsITypeAheadFind.FIND_NOTFOUND,
      searchString: this.searchString, findBackwards: false, linkURL: ""
    });
  }
  getInitialSelection() {
    // Selected-text extraction is not exposed by the native view yet.
    for (let listener of this.listeners) listener.onCurrentSelection("", true);
  }
  setSearchStringToSelection() { return ""; }
  focusContent() { this.view.focus(); }
  onFindbarClose() { this.view.native.clearFind(); }
  removeSelection() { this.view.native.clearFind(); }
  onFindbarOpen() {
    let bar = gBrowser.getFindBar(this.view.tab);
    // These Gecko-specific modes are not offered by this initial find adapter.
    for (let name of ["find-entire-word", "highlight", "found-matches"])
      if (bar.getElement(name)) bar.getElement(name).style.display = "none";
    ContentEngines.layout();
  }
  // Presentation-only callbacks from findbar; WPE owns match painting.
  enableSelection() {}
  onModalHighlightChange() {}
  onHighlightAllChange() {}
  highlight() {}
  requestMatchesCount() {}
  keyPress() {}
  destroy() { this.listeners.clear(); }
}
