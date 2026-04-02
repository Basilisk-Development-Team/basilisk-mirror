# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import importlib.machinery
import importlib.util
import os
import sys
import types

try:
    import imp  # noqa: F401
except ImportError:
    compat_imp = types.ModuleType('imp')
    compat_imp.PY_SOURCE = 1

    def _load_module(name, fileobj, pathname, desc):
        try:
            loader = importlib.machinery.SourceFileLoader(name, pathname)
            spec = importlib.util.spec_from_loader(name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            sys.modules[name] = module
            return module
        finally:
            if fileobj is not None:
                fileobj.close()

    compat_imp.load_module = _load_module
    sys.modules['imp'] = compat_imp

old_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True

base_dir = os.path.abspath(os.path.dirname(__file__))
ycm_path = os.path.join(base_dir, 'platform', '.ycm_extra_conf.py')
spec = importlib.util.spec_from_file_location('_ycm_extra_conf', ycm_path)
ycm_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ycm_module)

sys.dont_write_bytecode = old_bytecode

# Expose the FlagsForFile function from platform/.ycm_extra_conf.py
FlagsForFile = ycm_module.FlagsForFile
