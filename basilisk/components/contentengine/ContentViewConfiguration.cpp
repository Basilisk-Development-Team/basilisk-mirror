/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "ContentViewConfiguration.h"
#include "nsGlobalWindow.h"
#include "nsDirectoryServiceUtils.h"
#include "nsAppDirectoryServiceDefs.h"
#include "mozilla/Preferences.h"
nsresult GetContentViewConfiguration(mozIDOMWindowProxy* window, ContentViewConfiguration& config)
{
  NS_ENSURE_ARG_POINTER(window);
  NS_ENSURE_TRUE(mozilla::Preferences::GetBool("webkit.enabled", true), NS_ERROR_NOT_AVAILABLE);
  auto* chrome = nsGlobalWindow::Cast(window);
  NS_ENSURE_TRUE(chrome->IsChromeWindow(), NS_ERROR_DOM_SECURITY_ERR);
  config.privateBrowsing = chrome->IsPrivateBrowsing();
  mozilla::Preferences::GetCString("browser.contentEngine.userAgent", &config.userAgent);
  return NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(config.profileDirectory));
}
