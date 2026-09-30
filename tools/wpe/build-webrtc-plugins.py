#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Build only the missing WebRTC plugin/ICE dependency for GStreamer 1.28.1.

Use system GStreamer core, base/good/bad runtime libraries and codec plugins.
This helper deliberately refuses another core version: do not mix plugin ABIs
or indiscriminately bundle a host multimedia installation. Sources are pristine.
"""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

root = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--work', type=Path, default=root / 'build-wpe-deps')
p.add_argument('--downloads', type=Path, help='Shared archive cache (defaults to --work)')
p.add_argument('--prefix', type=Path, required=True)
p.add_argument('--jobs', type=int, default=4)
a = p.parse_args()
work, prefix = a.work.resolve(), a.prefix.resolve()
downloads = a.downloads.resolve() if a.downloads else work
if subprocess.check_output(['pkg-config', '--modversion', 'gstreamer-1.0'], text=True).strip() != '1.28.1':
    raise SystemExit('This pinned plugin build requires system GStreamer 1.28.1')
work.mkdir(parents=True, exist_ok=True)
downloads.mkdir(parents=True, exist_ok=True)
download_lock = (downloads / '.wpe-media-downloads.lock').open('a')
fcntl.flock(download_lock, fcntl.LOCK_EX)
for name, url, digest in [
    ('libnice-0.1.23', 'https://libnice.freedesktop.org/releases/libnice-0.1.23.tar.gz',
     '618fc4e8de393b719b1641c1d8eec01826d4d39d15ade92679d221c7f5e4e70d'),
    ('gst-plugins-bad-1.28.1', 'https://gstreamer.freedesktop.org/src/gst-plugins-bad/gst-plugins-bad-1.28.1.tar.xz',
     '56c1593787f8b5550893d59e4ff29e6bcccf34973316fa55e34ce493e04313a2')]:
    archive = downloads / url.rsplit('/', 1)[1]
    if not archive.exists():
        temporary = archive.with_suffix(archive.suffix + '.part')
        try:
            urllib.request.urlretrieve(url, temporary)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                raise SystemExit('Source checksum mismatch: ' + str(temporary))
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != digest: raise SystemExit('Source checksum mismatch: ' + str(archive))
    if not (work / name).exists(): subprocess.check_call(['tar', '-xf', str(archive), '-C', str(work)])
fcntl.flock(download_lock, fcntl.LOCK_UN)
media = work / 'media-prefix'

def setup(build, source, options, env=None):
    command = ['meson', 'setup']
    if (build / 'build.ninja').exists(): command += ['--reconfigure']
    subprocess.check_call(command + [str(build), str(source), '--prefix=' + str(media), '--libdir=lib',
        '-Dauto_features=disabled', '-Dbuildtype=release'] + options, env=env)

nice = work / 'libnice-build'
setup(nice, work / 'libnice-0.1.23', ['-Dgstreamer=enabled'])
subprocess.check_call(['meson', 'compile', '-C', str(nice), '-j', str(a.jobs)])
subprocess.check_call(['meson', 'install', '-C', str(nice)])
env = dict(os.environ, PKG_CONFIG_PATH=str(media / 'lib/pkgconfig') + ':' + os.environ.get('PKG_CONFIG_PATH', ''))
gst = work / 'gst-webrtc-build'
setup(gst, work / 'gst-plugins-bad-1.28.1', ['-Dwebrtc=enabled', '-Ddtls=enabled', '-Dsrtp=enabled', '-Dsctp=enabled'], env)
subprocess.check_call(['meson', 'compile', '-C', str(gst), '-j', str(a.jobs), 'gstwebrtc'], env=env)
lib = prefix / 'lib64'
(lib / 'gstreamer-1.0').mkdir(parents=True, exist_ok=True)
for source, target in [
    (media / 'lib/libnice.so.10', lib / 'libnice.so.10'),
    (media / 'lib/gstreamer-1.0/libgstnice.so', lib / 'gstreamer-1.0/libgstnice.so'),
    (gst / 'gst-libs/gst/webrtc/nice/libgstwebrtcnice-1.0.so.0', lib / 'libgstwebrtcnice-1.0.so.0'),
    (gst / 'ext/webrtc/libgstwebrtc.so', lib / 'gstreamer-1.0/libgstwebrtc.so')]:
    shutil.copy2(source.resolve(), target)
licenses = prefix / 'share/wpe-webkit-2.0/licenses/media'
licenses.mkdir(parents=True, exist_ok=True)
for name in ('libnice-0.1.23', 'gst-plugins-bad-1.28.1'):
    for source in (work / name).glob('COPYING*'): shutil.copy2(source, licenses / (name + '-' + source.name))
print('Staged webrtcbin, its NICE adapter and libnice; system codecs/transports remain system dependencies')
