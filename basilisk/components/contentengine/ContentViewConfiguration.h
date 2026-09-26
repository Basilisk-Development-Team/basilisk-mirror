/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ContentViewConfiguration_h
#define ContentViewConfiguration_h
#include "nsCOMPtr.h"
#include "nsIFile.h"
#include "nsString.h"
class mozIDOMWindowProxy;
// Project-owned configuration. Backend adapters choose their own supported
// storage APIs; they must not open any persistent store when privateBrowsing.
struct ContentViewConfiguration {
  nsCOMPtr<nsIFile> profileDirectory;
  bool privateBrowsing = false;
  nsCString userAgent; // Empty means the backend's default.
};
nsresult GetContentViewConfiguration(mozIDOMWindowProxy*, ContentViewConfiguration&);
#endif
