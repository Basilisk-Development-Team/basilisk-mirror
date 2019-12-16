# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

installer:
	@$(MAKE) -C basilisk/installer installer

package:
	@$(MAKE) -C basilisk/installer make-archive

l10n-package:
	@$(MAKE) -C basilisk/installer make-langpack

mozpackage:
	@$(MAKE) -C basilisk/installer

package-compare:
	@$(MAKE) -C basilisk/installer package-compare

stage-package:
	@$(MAKE) -C basilisk/installer stage-package make-buildinfo-file

sdk:
	@$(MAKE) -C basilisk/installer make-sdk

install::
	@$(MAKE) -C basilisk/installer install

clean::
	@$(MAKE) -C basilisk/installer clean

distclean::
	@$(MAKE) -C basilisk/installer distclean

source-package::
	@$(MAKE) -C basilisk/installer source-package

upload::
	@$(MAKE) -C basilisk/installer upload

source-upload::
	@$(MAKE) -C basilisk/installer source-upload

hg-bundle::
	@$(MAKE) -C basilisk/installer hg-bundle

l10n-check::
	@$(MAKE) -C basilisk/locales l10n-check

ifdef ENABLE_TESTS
# Implemented in testing/testsuite-targets.mk

mochitest-browser-chrome:
	$(RUN_MOCHITEST) --flavor=browser
	$(CHECK_TEST_ERROR)

mochitest:: mochitest-browser-chrome

.PHONY: mochitest-browser-chrome

endif
