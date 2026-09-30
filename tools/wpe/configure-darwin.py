#!/usr/bin/env python3
"""Configure the experimental full-source WPE Darwin port, without installing.

This is a no-media bring-up configuration. It does not select the Basilisk
backend, alter Gecko, or claim a distributable runtime. Extra CMake arguments
may follow --. Dependencies must already exist in --prefix or /opt/local.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/WebKit-darwin-upstream')
parser.add_argument('--build', type=Path, default=root / 'build-wpe-deps/darwin-full-build')
parser.add_argument('--prefix', type=Path, default=root / 'build-wpe-deps/darwin-prefix')
parser.add_argument('--sdk', type=Path)
parser.add_argument('--install-prefix', type=Path, default=root / 'build-wpe-deps/darwin-runtime')
parser.add_argument('options', nargs=argparse.REMAINDER)
args = parser.parse_args()
if sys.platform != 'darwin':
    parser.error('This experimental configuration requires a Darwin host')
subprocess.check_call([sys.executable, str(root / 'tools/wpe/verify-darwin-source.py'),
                       '--source', str(args.source)])
sdk = args.sdk or Path(subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip())
prefix = args.prefix.resolve()
install = args.install_prefix.resolve()
ninja = shutil.which('ninja') or '/opt/local/bin/ninja'
disabled = '''API_TESTS LAYOUT_TESTS MINIBROWSER DOCUMENTATION INTROSPECTION
    WPE_PLATFORM_DRM WPE_PLATFORM_WAYLAND WPE_LEGACY_API WPE_QT_API
    BUBBLEWRAP_SANDBOX JOURNALD_LOG GAMEPAD VIDEO WEB_AUDIO WEB_RTC
    MEDIA_STREAM MEDIA_RECORDER ENCRYPTED_MEDIA SPEECH_SYNTHESIS SPELLCHECK'''.split()
unused = 'ATK GBM LIBDRM LIBHYPHEN JPEGXL AVIF FLITE SPIEL LIBBACKTRACE'.split()
unused += ['GSTREAMER', 'GSTREAMER_GL', 'GSTREAMER_MPEGTS', 'GSTREAMER_WEBRTC',
           'LIBRICE', 'SYSPROF_CAPTURE', 'SYSTEM_SYSPROF_CAPTURE']
command = ['cmake', '-S', str(args.source.resolve()), '-B', str(args.build.resolve()), '-G', 'Ninja',
           '-DPORT=WPE', '-DCMAKE_BUILD_TYPE=Release', '-DDEVELOPER_MODE=ON',
           '-DDEVELOPER_MODE_FATAL_WARNINGS=OFF', '-DCLANGD_AUTO_SETUP=OFF',
           '-DCMAKE_MAKE_PROGRAM=' + ninja, '-DCMAKE_OSX_ARCHITECTURES=arm64',
           '-DCMAKE_OSX_SYSROOT=' + str(sdk),
           '-DCMAKE_PREFIX_PATH=' + str(prefix) + ';/opt/local',
           '-DCMAKE_FIND_FRAMEWORK=LAST',
           '-DCMAKE_INSTALL_PREFIX=' + str(install),
           '-DLIB_INSTALL_DIR=' + str(install / 'lib'),
           '-DEXEC_INSTALL_DIR=' + str(install / 'bin'),
           '-DLIBEXEC_INSTALL_DIR=' + str(install / 'libexec/wpe-webkit-2.0'),
           '-DEpoxy_INCLUDE_DIR=' + str(prefix / 'include'),
           '-DEpoxy_LIBRARY=' + str(prefix / 'lib/libepoxy.dylib'),
           '-DUSE_ANGLE_EGL=ON', '-DENABLE_C_LOOP=OFF', '-DENABLE_JIT=ON',
           '-DENABLE_DFG_JIT=ON', '-DENABLE_FTL_JIT=ON']
command += ['-DENABLE_' + name + '=OFF' for name in disabled]
command += ['-DUSE_' + name + '=OFF' for name in unused]
options = args.options[1:] if args.options[:1] == ['--'] else args.options
environment = dict(os.environ,
    PKG_CONFIG_PATH=str(prefix / 'lib/pkgconfig') + ':/opt/local/lib/pkgconfig',
    PYTHONPYCACHEPREFIX=str(args.build.resolve() / 'python-cache'))
subprocess.check_call(command + options, env=environment)
print('Configured experimental WPE Darwin build:', args.build.resolve())
