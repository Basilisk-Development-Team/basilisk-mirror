#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Build pristine upstream WPE with relocatable helper lookup, then stage it.

Uses upstream CMake, never installs into /usr and never edits WebKit sources.
Additional CMake dependency/feature options may follow --. Use --interpreter for
JSC CLoop without JIT on any supported architecture. Existing cache options are
otherwise retained. A cache explicitly configured with another DEVELOPER_MODE
identity may require a new build directory (as required by upstream CMake).
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/wpewebkit-2.54.0')
parser.add_argument('--build', type=Path, default=root / 'build-wpe-deps/wpe-runtime-build')
parser.add_argument('--stage', type=Path, default=root / 'build-wpe-deps/runtime-stage')
parser.add_argument('--jobs', type=int, default=4)
parser.add_argument('--interpreter', action='store_true')
parser.add_argument('--install-only', action='store_true')
parser.add_argument('cmake_options', nargs=argparse.REMAINDER)
args = parser.parse_args()
source, build, stage = args.source.resolve(), args.build.resolve(), args.stage.resolve()
if not args.install_only:
    options = args.cmake_options
    if options[:1] == ['--']: options = options[1:]
    command = ['cmake', '-S', str(source), '-B', str(build), '-G', 'Ninja',
               '-DPORT=WPE', '-DCMAKE_BUILD_TYPE=Release', '-DDEVELOPER_MODE=ON',
               '-DDEVELOPER_MODE_FATAL_WARNINGS=OFF', '-DCLANGD_AUTO_SETUP=OFF',
               '-DENABLE_API_TESTS=OFF', '-DENABLE_LAYOUT_TESTS=OFF', '-DENABLE_MINIBROWSER=OFF',
               '-DENABLE_WEB_RTC=ON', '-DUSE_GSTREAMER_WEBRTC=ON',
               '-DENABLE_BUBBLEWRAP_SANDBOX=ON', '-DCMAKE_INSTALL_PREFIX=/usr', '-DEXEC_INSTALL_DIR=/usr/bin',
               '-DCMAKE_INSTALL_LIBDIR=lib64', '-DLIB_INSTALL_DIR=/usr/lib64',
               '-DLIBEXEC_INSTALL_DIR=/usr/libexec/wpe-webkit-2.0', '-DCMAKE_INSTALL_DATADIR=share']
    if args.interpreter:
        command += ['-DENABLE_C_LOOP=ON', '-DENABLE_JIT=OFF', '-DENABLE_DFG_JIT=OFF', '-DENABLE_FTL_JIT=OFF']
    subprocess.check_call(command + options)
    subprocess.check_call(['cmake', '--build', str(build), '--parallel', str(args.jobs)])
cache = (build / 'CMakeCache.txt').read_text()
if 'CMAKE_INSTALL_PREFIX:PATH=/usr\n' not in cache:
    raise SystemExit('Expected a conventional /usr compiled prefix; choose --stage for the actual install destination')
environment = dict(os.environ, DESTDIR=str(stage))
subprocess.check_call(['cmake', '--install', str(build)], env=environment)
prefix = stage / 'usr'
# pkg-config is build metadata, not shipped runtime data. Point it at the staged
# install while preserving conventional compiled-in upstream fallback paths.
for pc in (prefix / 'lib64/pkgconfig').glob('*.pc'):
    lines = []
    for line in pc.read_text().splitlines():
        if '=' in line and not line.startswith((' ', '#')):
            name, value = line.split('=', 1)
            if value == '/usr' or value.startswith('/usr/'):
                line = name + '=' + str(prefix) + value[4:]
        lines.append(line)
    pc.write_text('\n'.join(lines) + '\n')
# Adapter-owned runtime metadata: feature values only, never developer paths.
features = {}
for name in ('ENABLE_WEB_RTC', 'USE_GSTREAMER_WEBRTC', 'USE_LIBRICE', 'ENABLE_BUBBLEWRAP_SANDBOX',
             'ENABLE_MEDIA_STREAM', 'ENABLE_C_LOOP', 'ENABLE_JIT', 'ENABLE_DFG_JIT', 'ENABLE_FTL_JIT'):
    match = re.search(r'^' + name + r':BOOL=(ON|OFF)$', cache, re.M)
    features[name] = bool(match and match.group(1) == 'ON')
metadata = prefix / 'share/wpe-webkit-2.0/basilisk-build.ini'
metadata.write_text('[Build]\n' + ''.join('%s=%s\n' % (name, str(value).lower()) for name, value in features.items()))
licenses = prefix / 'share/wpe-webkit-2.0/licenses'
for path in (source / 'Source').rglob('*'):
    if path.is_file() and re.match(r'^(LICENSE|COPYING)([.-].*)?$', path.name, re.I):
        target = licenses / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
print('WPE runtime prefix:', prefix)
print('Build with PKG_CONFIG_PATH=' + str(prefix / 'lib64/pkgconfig'))
