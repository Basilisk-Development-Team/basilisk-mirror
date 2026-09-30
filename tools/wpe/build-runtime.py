#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Build verified upstream WPE plus the documented patch series, then stage it.

Uses upstream CMake, never installs into /usr and never silently repairs sources.
Additional CMake dependency/feature options may follow --. Use --interpreter for
JSC CLoop without JIT on any supported architecture. Existing cache options are
otherwise retained. A cache explicitly configured with another DEVELOPER_MODE
identity may require a new build directory (as required by upstream CMake).
"""
import argparse
import fcntl
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/wpewebkit-2.54.0')
parser.add_argument('--build', type=Path, default=root / 'build-wpe-deps/wpe-runtime-build')
parser.add_argument('--stage', type=Path, default=root / 'build-wpe-deps/runtime-stage')
parser.add_argument('--source-archive', type=Path, default=root / 'build-wpe-deps/downloads/wpewebkit-2.54.0.tar.xz')
parser.add_argument('--jobs', type=int, default=4)
parser.add_argument('--prepare-source', action='store_true',
                    help='Fetch/extract/apply the pinned series if source is absent (mach build)')
parser.add_argument('--interpreter', action='store_true')
parser.add_argument('--install-only', action='store_true')
parser.add_argument('cmake_options', nargs=argparse.REMAINDER)
args = parser.parse_args()
source, build, stage = args.source.resolve(), args.build.resolve(), args.stage.resolve()
build.parent.mkdir(parents=True, exist_ok=True)
build_lock = (build.parent / ('.' + build.name + '.lock')).open('a')
fcntl.flock(build_lock, fcntl.LOCK_EX)
print('Building WPE WebKit in ' + str(build), flush=True)
if args.prepare_source:
    subprocess.check_call([sys.executable, str(root / 'tools/wpe/prepare-source.py'),
                           '--source', str(source), '--archive', str(args.source_archive.resolve())])
# Prevent another object directory's preparation from changing sources while
# CMake/Ninja is using them. Preparation takes the same lock exclusively.
source_lock = (source.parent / '.wpe-source.lock').open('a')
fcntl.flock(source_lock, fcntl.LOCK_SH)
subprocess.check_call([sys.executable, str(root / 'tools/wpe/verify-source.py'),
                       '--source', str(source), '--archive', str(args.source_archive.resolve()),
                       '--allow-python-cache'])
# Read/write generated Python bytecode in the object directory, not vendor source.
# This also prevents loading pre-existing source-side __pycache__ entries.
build_environment = dict(os.environ, PYTHONPYCACHEPREFIX=str(build / 'python-cache'))
# Optional locally installed host generators (not runtime libraries). Prefer
# normal system tools; the earlier standalone setup installed gperf/unifdef here.
host_tools = root / 'build-wpe-deps/prefix/bin'
if host_tools.is_dir():
    build_environment['PATH'] = os.pathsep.join([os.environ.get('PATH', ''), str(host_tools)])
if not args.install_only:
    options = args.cmake_options
    if options[:1] == ['--']: options = options[1:]
    command = ['cmake', '-S', str(source), '-B', str(build), '-G', 'Ninja',
               '-DPORT=WPE', '-DCMAKE_BUILD_TYPE=Release', '-DDEVELOPER_MODE=ON',
               '-DDEVELOPER_MODE_FATAL_WARNINGS=OFF', '-DCLANGD_AUTO_SETUP=OFF',
               '-DENABLE_JSC_RESTRICTED_OPTIONS_BY_DEFAULT=OFF',
               '-DENABLE_API_TESTS=OFF', '-DENABLE_LAYOUT_TESTS=OFF', '-DENABLE_MINIBROWSER=OFF',
               '-DENABLE_DOCUMENTATION=OFF', '-DENABLE_INTROSPECTION=OFF',
               '-DENABLE_WPE_PLATFORM=ON', '-DENABLE_WPE_1_1_API=OFF', '-DENABLE_WPE_LEGACY_API=OFF',
               '-DENABLE_WPE_PLATFORM_DRM=OFF', '-DENABLE_WPE_PLATFORM_WAYLAND=OFF',
               '-DENABLE_WPE_PLATFORM_HEADLESS=ON',
               '-DENABLE_WPE_QT_API=OFF', '-DUSE_SYSTEM_SYSPROF_CAPTURE=OFF',
               '-DENABLE_WEB_RTC=ON', '-DUSE_GSTREAMER_WEBRTC=ON',
               '-DENABLE_BUBBLEWRAP_SANDBOX=ON', '-DCMAKE_INSTALL_PREFIX=/usr', '-DEXEC_INSTALL_DIR=/usr/bin',
               '-DCMAKE_INSTALL_LIBDIR=lib64', '-DLIB_INSTALL_DIR=/usr/lib64',
               '-DLIBEXEC_INSTALL_DIR=/usr/libexec/wpe-webkit-2.0', '-DCMAKE_INSTALL_DATADIR=share']
    if args.interpreter:
        command += ['-DENABLE_C_LOOP=ON', '-DENABLE_JIT=OFF', '-DENABLE_DFG_JIT=OFF', '-DENABLE_FTL_JIT=OFF']
    subprocess.check_call(command + options, env=build_environment)
    # Ninja 1.13+ can participate in GNU make's FIFO jobserver. Otherwise use
    # the explicit/default limit rather than launching an unbounded build.
    command = ['cmake', '--build', str(build)]
    ninja_version = subprocess.check_output(['ninja', '--version'], text=True,
                                           env=build_environment).strip().split('.')
    jobserver = ('--jobserver-auth=fifo:' in os.environ.get('MAKEFLAGS', '') and
                 tuple(map(int, ninja_version[:2])) >= (1, 13))
    if not jobserver:
        command += ['--parallel', str(args.jobs)]
    subprocess.check_call(command, env=build_environment)
cache = (build / 'CMakeCache.txt').read_text()
if 'CMAKE_INSTALL_PREFIX:PATH=/usr\n' not in cache:
    raise SystemExit('Expected a conventional /usr compiled prefix; choose --stage for the actual install destination')
environment = dict(build_environment, DESTDIR=str(stage))
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
# Preserve the narrow WebRTC supplement shipped by the existing 1.28.1 build.
# Other GStreamer versions use their matching system plugins; never mix ABIs.
if args.prepare_source and features['USE_GSTREAMER_WEBRTC']:
    gst_version = subprocess.check_output(['pkg-config', '--modversion', 'gstreamer-1.0'],
                                          text=True, env=build_environment).strip()
    if gst_version == '1.28.1':
        subprocess.check_call([sys.executable, str(root / 'tools/wpe/build-webrtc-plugins.py'),
                               '--work', str(build.parent / 'media'),
                               '--downloads', str(root / 'build-wpe-deps'),
                               '--prefix', str(prefix), '--jobs', str(args.jobs)],
                              env=build_environment)
    else:
        # Do not leave plugins for the old pinned version in an incremental
        # install after the system GStreamer version changes.
        for relative in ('lib64/libnice.so.10', 'lib64/libgstwebrtcnice-1.0.so.0',
                         'lib64/gstreamer-1.0/libgstnice.so',
                         'lib64/gstreamer-1.0/libgstwebrtc.so'):
            (prefix / relative).unlink(missing_ok=True)
licenses = prefix / 'share/wpe-webkit-2.0/licenses'
for path in (source / 'Source').rglob('*'):
    if path.is_file() and re.match(r'^(LICENSE|COPYING)([.-].*)?$', path.name, re.I):
        target = licenses / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
print('WPE runtime prefix:', prefix)
if not args.prepare_source:
    print('To use this standalone runtime, add to mozconfig:')
    print('ac_add_options --enable-webkit')
    print('ac_add_options --with-wpe-runtime=' + shlex.quote(str(prefix)))
