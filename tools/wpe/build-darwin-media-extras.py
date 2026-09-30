#!/usr/bin/env python3
"""Build a bounded, unmodified GStreamer VideoToolbox/media dependency set.

Requires the matching GStreamer core/base development packages and Meson.
Installs only six additional binaries into a WPE SDK; never changes MacPorts.
The normal Darwin packager subsequently relocates/signs distribution copies.
"""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request

VERSION = '1.28.7'
SOURCES = {
    'base': 'ed6e5410f496d171818763af2265e7977154bc7f9b827e98acf8c5bed21dd5a7',
    'bad': 'dc525383c18b2c265bbe6a43d498656cd918aaa130aa4e3abeabcdaa741c3ffe',
}
PLUGINS = ('applemedia', 'videoparsersbad', 'debugutilsbad', 'subenc')
root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, required=True, help='Installed media-enabled WPE SDK')
parser.add_argument('--work', type=Path, default=root / 'build-wpe-deps')
parser.add_argument('--meson', default='meson')
parser.add_argument('-j', type=int, default=4)
args = parser.parse_args()


def output(*command):
    return subprocess.check_output(command, text=True).strip()


def run(*command):
    subprocess.run([str(part) for part in command], check=True)


for package in ('gstreamer-1.0', 'gstreamer-video-1.0'):
    if output('pkg-config', '--modversion', package) != VERSION:
        raise RuntimeError('GStreamer development packages must match ' + VERSION)
work = args.work.resolve()
work.mkdir(parents=True, exist_ok=True)
prefix = args.prefix.resolve(strict=True)
if not (prefix / 'lib/libWPEWebKit-2.0.dylib').is_file():
    raise RuntimeError('Not an installed WPE SDK')
installs = {}
for kind, checksum in SOURCES.items():
    name = 'gst-plugins-' + kind + '-' + VERSION
    archive = work / (name + '.tar.xz')
    if not archive.exists():
        urllib.request.urlretrieve('https://gstreamer.freedesktop.org/src/gst-plugins-' + kind + '/' + archive.name, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError('Source checksum mismatch: ' + str(archive))
    source = work / name
    if not source.exists():
        run('tar', '-xf', archive, '-C', work)
    suffix = 'gl' if kind == 'base' else 'extra'
    build = work / ('darwin-gst-' + suffix + '-build')
    install = work / ('darwin-gst-' + suffix + '-runtime')
    installs[kind] = install
    options = ['-Dauto_features=disabled', '-Dgl=enabled']
    if kind == 'base':
        options += ['-Dgl_api=opengl', '-Dgl_platform=cgl', '-Dgl_winsys=cocoa']
    else:
        # Prefer the installed common base libraries; consume only GL from the
        # supplementary build. Both sets are the exact same upstream version.
        system_pc = output('pkg-config', '--variable=pcfiledir', 'gstreamer-video-1.0')
        options += ['-Dpkg_config_path=' + system_pc + ',' + str(installs['base'] / 'lib/pkgconfig'),
                    '-Dapplemedia=enabled', '-Dvideoparsers=enabled',
                    '-Ddebugutils=enabled', '-Dsubenc=enabled', '-Daudiofxbad=disabled']
    reconfigure = ['--reconfigure'] if (build / 'meson-private/coredata.dat').exists() else []
    run(args.meson, 'setup', *reconfigure, build, source, '--prefix', install,
        '--libdir', 'lib', '--wrap-mode=nofallback', *options)
    run('ninja', '-C', build, '-j', args.j)
    run('ninja', '-C', build, 'install')

files = {installs['base'] / 'lib/libgstgl-1.0.0.dylib': prefix / 'lib/libgstgl-1.0.0.dylib',
         installs['bad'] / 'lib/libgstcodecparsers-1.0.0.dylib': prefix / 'lib/libgstcodecparsers-1.0.0.dylib'}
for plugin in PLUGINS:
    relative = Path('lib/gstreamer-1.0/libgst' + plugin + '.dylib')
    files[installs['bad'] / relative] = prefix / relative
for source, target in files.items():
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    command = ['install_name_tool', '-id', str(target)]
    for line in output('otool', '-L', source).splitlines()[1:]:
        dependency = line.strip().split(' (compatibility version')[0]
        if Path(dependency) in files:
            command += ['-change', dependency, str(files[Path(dependency)])]
        elif dependency in ('@rpath/libgstvideo-1.0.0.dylib',
                             str(installs['base'] / 'lib/libgstvideo-1.0.0.dylib')):
            # GL's upstream build links its own base sibling. Reuse the same
            # version already used by WPE, avoiding two gstvideo libraries.
            video = Path(output('pkg-config', '--variable=libdir', 'gstreamer-video-1.0')) / 'libgstvideo-1.0.0.dylib'
            command += ['-change', dependency, str(video.resolve(strict=True))]
    for path in dict.fromkeys(re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset', output('otool', '-l', source))):
        command += ['-delete_rpath', path]
    run(*command, target)
    run('codesign', '--force', '--sign', '-', target)
licenses = prefix / 'share/wpe-webkit-2.0/media-licenses'
licenses.mkdir(parents=True, exist_ok=True)
for kind in SOURCES:
    shutil.copy2(work / ('gst-plugins-' + kind + '-' + VERSION) / 'COPYING',
                 licenses / ('GStreamer-' + kind + '-COPYING.txt'))
print('Installed bounded VideoToolbox/parser/sink/subtitle extras:', prefix)
