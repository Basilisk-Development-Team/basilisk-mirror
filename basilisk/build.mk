# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# These are root compile-graph prerequisites, not directory traversal order:
# parallel builds must finish WPE's headers and library before either consumer
# starts. libxul already depends on the contentengine/wpe target.
ifdef WPE_BUILD_FROM_SOURCE
.PHONY: wpe-runtime
basilisk/components/contentengine/wpe/target basilisk/components/contentengine/wpe/extension/target: wpe-runtime

wpe-runtime:
	+$(PYTHON) $(WPE_SOURCE_ROOT)/tools/wpe/build-runtime.py --prepare-source --build "$(WPE_BUILD_DIR)" --stage "$(WPE_RUNTIME_PREFIX)/.." $(if $(WPE_INTERPRETER),--interpreter)
endif

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
