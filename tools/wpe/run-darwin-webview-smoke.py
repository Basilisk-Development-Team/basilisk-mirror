#!/usr/bin/env python3
"""Run a standalone Darwin WPE view using this build's library and helpers.

This deliberately uses build paths for port diagnostics; it is not a package
launcher or evidence that the eventual application is relocatable.
"""
import argparse
import runpy
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('uri', nargs='?')
parser.add_argument('--cycles', type=int, default=1)
parser.add_argument('--content-bridge', action='store_true')
parser.add_argument('--host', action='store_true', help='Test the browser-facing Cocoa host boundary')
parser.add_argument('--inspector', action='store_true', help='Also verify host Inspector ownership')
parser.add_argument('--expect-title', help='Wait for an asynchronous page fixture to report this title')
parser.add_argument('--build', type=Path, default=root / 'build-wpe-deps/darwin-full-build')
parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/WebKit-darwin-upstream')
args = parser.parse_args()
if args.inspector and not args.host:
    parser.error('--inspector requires --host')
if args.host and args.content_bridge:
    parser.error('--host and --content-bridge use separate fixtures')
if args.expect_title and (not args.uri or args.host):
    parser.error('--expect-title requires a URI and the standalone view fixture')
if not 1 <= args.cycles <= 1000:
    parser.error('--cycles must be between 1 and 1000')
build, source = args.build.resolve(), args.source.resolve()
prefix = root / 'build-wpe-deps/darwin-prefix'
library = build / 'lib/libWPEWebKit-2.0.dylib'
required = [library, build / 'bin/WPEWebProcess', build / 'bin/WPENetworkProcess']
for path in required:
    if not path.is_file():
        raise SystemExit('Missing build product: ' + str(path))
env = dict(os.environ)
env['PKG_CONFIG_PATH'] = str(prefix / 'lib/pkgconfig') + ':/opt/local/lib/pkgconfig'
env['DYLD_LIBRARY_PATH'] = str(build / 'lib') + ':' + str(prefix / 'lib')
env['WPE_SMOKE_CYCLES'] = str(args.cycles)
env['WPE_SMOKE_INSPECTOR'] = '1' if args.inspector else ''
if args.expect_title:
    env['WPE_SMOKE_EXPECT_TITLE'] = args.expect_title
env['WEBKIT_EXEC_PATH'] = str(build / 'bin')
env['WEBKIT_INJECTED_BUNDLE_PATH'] = str(build / 'lib')
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs',
    'gio-2.0', 'libsoup-3.0', 'xkbcommon'], env=env, text=True))
host = root / 'basilisk/components/contentengine/wpe/darwin'
with tempfile.TemporaryDirectory(prefix='wpe-darwin-webview-') as directory:
    directory = Path(directory)
    env['XDG_CACHE_HOME'] = str(directory / 'cache')
    env['XDG_DATA_HOME'] = str(directory / 'data')
    env['WEBKIT_INSPECTOR_RESOURCES_PATH'] = str(build / 'share')
    # Public non-generated JSC headers are installed into jsc/ by upstream.
    # Supply that layout for this uninstalled build without changing its tree.
    (directory / 'jsc').symlink_to(source / 'Source/JavaScriptCore/API/glib')
    includes = [host, build / 'DerivedSources/WebKit',
        build / 'JavaScriptCoreGLib/DerivedSources', directory,
        build / 'DerivedSources/WPEPlatform', source / 'Source/WebKit/WPEPlatform',
        source / 'Source/WebKit/UIProcess/API']
    binary = directory / 'webview-smoke'
    fixture = 'darwin-host-smoke.mm' if args.host else 'darwin-webview-smoke.mm'
    extra_sources = [str(host / 'WPEHostCocoa.mm')] if args.host else []
    subprocess.run(['clang++', '-std=c++17', '-fno-objc-arc',
        *['-I' + str(path) for path in includes],
        str(root / 'tools/wpe' / fixture), *extra_sources,
        str(host / 'WPECocoaSurface.mm'), str(host / 'WPECocoaClipboard.mm'), str(host / 'WPEGLibRunLoop.mm'),
        str(library), *flags, '-framework', 'AppKit', '-framework', 'CoreFoundation',
        '-Wl,-rpath,' + str(build / 'lib'), '-o', str(binary)], env=env, check=True)
    if args.content_bridge:
        extension = directory / 'extensions'
        extension.mkdir()
        bridge = root / 'basilisk/components/contentengine/wpe/extension'
        generator = runpy.run_path(str(bridge / 'generate-runtime.py'))
        with (directory / 'LegacyContent.inc').open('w') as output:
            generator['main'](output, str(bridge / 'LegacyContent.js'))
        subprocess.run(['clang++', '-std=c++17', '-dynamiclib',
            *['-I' + str(path) for path in includes],
            str(bridge / 'ContentExtension.cpp'), str(bridge / 'LegacyContent.cpp'),
            str(library), *flags, '-Wl,-rpath,' + str(build / 'lib'),
            '-o', str(extension / 'libbasilisk-content-extension.so')], env=env, check=True)
        env['WPE_SMOKE_EXTENSION_PATH'] = str(extension)
    command = [str(binary)] + ([args.uri] if args.uri else [])
    subprocess.run(command, env=env, check=True, timeout=60 * args.cycles)
