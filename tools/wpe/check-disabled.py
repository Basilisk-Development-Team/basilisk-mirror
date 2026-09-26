#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Verify a completed --disable-webkit ELF build, including packaged resources.

Usage: python3 tools/wpe/check-disabled.py /path/to/obj-webkit-disabled
Run only on your own trusted build: ldd inspects the runtime dependency closure.
"""
import pathlib
import os
import re
import subprocess
import sys
import zipfile

obj = pathlib.Path(sys.argv[1]).resolve()
def require(condition, message):
    if not condition:
        raise SystemExit("FAIL: " + message)

header = (obj / 'mozilla-config.h').read_text()
require(not re.search(r'^\s*#\s*define\s+MOZ_WEBKIT\b', header, re.M),
        'MOZ_WEBKIT is defined')
backend = (obj / 'backend.RecursiveMakeBackend.in').read_text()
require('components/contentengine/moz.build' not in backend and 'components/webkit/moz.build' not in backend,
        'WPE directory participated in the build')
root = obj / 'dist/bin'
# Auxiliary executables/components rely on the application's library directory
# being in the loader search path (normally supplied by the launcher). Resolve
# their transitive dependencies in that same environment, not as isolated files.
loader_env = dict(os.environ)
loader_env['LD_LIBRARY_PATH'] = str(root) + os.pathsep + loader_env.get('LD_LIBRARY_PATH', '')
require((root / 'basilisk').is_file(), 'build has no Basilisk executable')
require((root / 'libxul.so').is_file(), 'build has no libxul.so')
count = 0
for path in root.rglob('*'):
    if not path.is_file():
        continue
    require('/chrome/' not in path.as_posix() or not any(part in path.as_posix() for part in ('/contentengine/', '/webkit/')),
            'WPE chrome resource installed: ' + str(path))
    require(path.name != 'webcontentview.xpt', 'WPE interfaces installed')
    with path.open('rb') as stream:
        magic = stream.read(4)
    if magic == b'\x7fELF':
        count += 1
        dynamic = subprocess.check_output(['readelf', '-d', str(path)], text=True)
        needed = '\n'.join(line for line in dynamic.splitlines() if '(NEEDED)' in line)
        require(not re.search(r'webkit|wpe', needed, re.I),
                'WPE direct dependency: ' + str(path))
        if '(NEEDED)' in dynamic:
            closure = subprocess.run(['ldd', str(path)], text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     env=loader_env)
            require(closure.returncode == 0, 'ldd failed: ' + str(path))
            require('not found' not in closure.stdout, 'unresolved dependency: ' + str(path))
            # Match library names, not checkout paths that can contain "webkit".
            require(not re.search(r'^\s*\S*(?:webkit|wpe)\S*\s+=>', closure.stdout, re.I | re.M),
                    'WPE transitive dependency: ' + str(path))
        # Registration strings cannot be present, even if linkage is indirect.
        require(not any(contract in path.read_bytes() for contract in (b'@basilisk-browser.org/content-view;1?engine=webkit', b'@basilisk-browser.org/web-content-view/wpe;1')),
                'WPE component registered in ' + str(path))
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            require(not any(part in '/' + name for name in archive.namelist() for part in ('/contentengine/', '/webkit/')),
                    'WPE resources packaged in ' + str(path))
    elif path.suffix == '.xpt':
        require(not any(name in path.read_bytes() for name in
                (b'nsIWebContentView', b'nsIContentViewObserver', b'nsIContentRequestRule')),
                'WPE interface in merged typelib: ' + str(path))
print('PASS: no WPE define, build directory, component, interfaces, resources, or ELF dependency')
print('Inspected %d ELF files under %s' % (count, root))
