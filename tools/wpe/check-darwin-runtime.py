#!/usr/bin/env python3
"""Build a native fixture, stage WPE, and test relocation outside the checkout.

This does not launch Basilisk or establish browser/extension compatibility.
The final runs deny reads from the checkout and MacPorts to detect runtime
fallbacks. Logs distinguish the ordinary and hidden-tree runs.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, default=root / 'build-wpe-deps/darwin-runtime')
parser.add_argument('--dependencies', type=Path, default=root / 'build-wpe-deps/darwin-prefix')
parser.add_argument('--uri', default='https://example.com')
parser.add_argument('--expect-title', help='Require an asynchronous page result for --uri')
args = parser.parse_args()
prefix = args.prefix.resolve()
spec = importlib.util.spec_from_file_location('packager', root / 'tools/wpe/package-darwin-runtime.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
environment = dict(os.environ, PKG_CONFIG_PATH=str(prefix / 'lib/pkgconfig') + ':' +
                   str(args.dependencies.resolve() / 'lib/pkgconfig') + ':/opt/local/lib/pkgconfig')
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs',
    'wpe-webkit-2.0', 'xkbcommon'], env=environment, text=True))
with tempfile.TemporaryDirectory(prefix='wpe-darwin-relocated-') as directory:
    directory = Path(directory).resolve()
    dist = directory / 'bin'
    dist.mkdir()
    bridge = directory / 'bridge.so'
    host = root / 'basilisk/components/contentengine/wpe/darwin'
    subprocess.run(['clang++', '-std=c++17', '-dynamiclib',
        str(root / 'basilisk/components/contentengine/wpe/extension/ContentExtension.cpp'),
        *flags, '-o', str(bridge)], check=True)
    # Use the frontend's filename to exercise relocation of a distribution
    # symlink without altering its source build product. This remains a fixture.
    original = directory / 'fixture-original'
    subprocess.run(['clang++', '-std=c++17', '-fno-objc-arc', '-I' + str(host),
        str(root / 'tools/wpe/darwin-webview-smoke.mm'), str(host / 'WPECocoaSurface.mm'),
        str(host / 'WPEGLibRunLoop.mm'), str(host / 'WPECocoaClipboard.mm'), *flags, '-framework', 'AppKit',
        '-framework', 'CoreFoundation', '-o', str(original)], check=True)
    original_bytes = original.read_bytes()
    probe = dist / 'XUL'
    probe.symlink_to(original)
    packager.stage(prefix, dist, bridge, Path('/opt/local/lib/gio/modules/libgiognutls.so'))
    packager.relocate_frontend(dist)
    assert not probe.is_symlink() and original.read_bytes() == original_bytes
    runtime = dist / 'webkit'
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('DYLD_', 'WEBKIT_', 'WPE_', 'GIO_', 'G_TLS_', 'FONTCONFIG_', 'GST_'))}
    environment.update(WEBKIT_EXEC_PATH=str(runtime / 'libexec'),
        WEBKIT_INJECTED_BUNDLE_PATH=str(runtime / 'injected-bundle'),
        WEBKIT_INSPECTOR_RESOURCES_PATH=str(runtime / 'share'),
        WEBKIT_TLS_CAFILE_PEM=str(runtime / 'share/ca-bundle.pem'),
        WPE_PLATFORMS_PATH=str(runtime / 'lib/modules'),
        GIO_MODULE_DIR=str(runtime / 'lib/gio/modules'),
        FONTCONFIG_FILE=str(runtime / 'share/fontconfig/fonts.conf'))
    if (runtime / 'libexec/gst-plugin-scanner').is_file():
        environment.update(GST_PLUGIN_SCANNER_1_0=str(runtime / 'libexec/gst-plugin-scanner'),
            GST_PLUGIN_SYSTEM_PATH_1_0='', GST_PLUGIN_PATH_1_0=str(runtime / 'lib/gstreamer-1.0'),
            GST_REGISTRY_1_0=str(directory / 'registry.bin'))
    # All non-system dependencies must resolve in the copied distribution.
    for image in [probe, *[path for path in runtime.rglob('*') if path.is_file()]]:
        with image.open('rb') as stream:
            if stream.read(4) != b'\xcf\xfa\xed\xfe':
                continue
        own_name = packager.identity(image)
        for name in packager.names(image):
            if name == own_name or packager.system(name):
                continue
            if name.startswith('@loader_path/'):
                target = (image.parent / name[len('@loader_path/'):]).resolve()
            elif name.startswith('@rpath/') and image == probe:
                target = (runtime / 'lib' / name[len('@rpath/'):]).resolve()
            else:
                raise RuntimeError('Unexpected relocated dependency: ' + name)
            assert dist in target.parents and target.is_file(), (image, name)
    for hidden in (False, True):
        for uri in (None, args.uri):
            current = dict(environment, WPE_SMOKE_CYCLES='1' if hidden or uri else '3')
            if uri is None:
                current['WPE_SMOKE_EXTENSION_PATH'] = str(runtime / 'extensions')
            elif args.expect_title:
                current['WPE_SMOKE_EXPECT_TITLE'] = args.expect_title
            command = [str(probe)] + ([uri] if uri else [])
            if hidden:
                # Paths here are test-generated, never page-provided text.
                escaped = str(root).replace('\\', '\\\\').replace('"', '\\"')
                profile = '(version 1)(allow default)(deny file-read* (subpath "' + escaped + '") (subpath "/opt/local"))'
                command = ['/usr/bin/sandbox-exec', '-p', profile, *command]
            subprocess.run(command, env=current, check=True, timeout=180)
            print('PASS relocated runtime: hidden=%s, %s' % (hidden, uri or 'HTML/input/content bridge'), flush=True)
