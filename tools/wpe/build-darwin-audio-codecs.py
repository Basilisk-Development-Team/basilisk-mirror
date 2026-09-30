#!/usr/bin/env python3
"""Build a decoder-only AAC/MP3 GStreamer supplement in an isolated prefix.

No system packages are changed. FFmpeg networking, protocols, demuxers,
encoders, external libraries and programs are disabled. GStreamer remains the
WebKit media pipeline; libav supplies only the selected audio decoders.
"""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, required=True, help='Installed WPE media SDK')
parser.add_argument('--work', type=Path, default=root / 'build-wpe-deps')
parser.add_argument('--meson', default='meson')
parser.add_argument('-j', type=int, default=4)
args = parser.parse_args()
work = args.work.resolve()
prefix = args.prefix.resolve(strict=True)
if not (prefix / 'lib/libWPEWebKit-2.0.dylib').is_file():
    raise RuntimeError('Not an installed WPE SDK')
work.mkdir(parents=True, exist_ok=True)


def run(*command, cwd=None):
    subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def output(*command):
    return subprocess.check_output(command, text=True).strip()


if output('pkg-config', '--modversion', 'gstreamer-1.0') != '1.28.7':
    raise RuntimeError('Matching GStreamer 1.28.7 development packages required')
for name, url, checksum in (
    ('ffmpeg-8.1.2', 'https://ffmpeg.org/releases/',
     '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'),
    ('gst-libav-1.28.7', 'https://gstreamer.freedesktop.org/src/gst-libav/',
     '58da51dd39ecf1cf6faade34cc6412001be2e2e145bca8ae0f45336f60a36ab2')):
    archive = work / (name + '.tar.xz')
    if not archive.exists():
        urllib.request.urlretrieve(url + archive.name, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError('Source checksum mismatch: ' + str(archive))
    if not (work / name).exists():
        run('tar', '-xf', archive, '-C', work)

ffmpeg = work / 'darwin-ffmpeg-audio-runtime'
build = work / 'darwin-ffmpeg-audio-build'
build.mkdir(exist_ok=True)
run(work / 'ffmpeg-8.1.2/configure', '--prefix=' + str(ffmpeg),
    '--disable-everything', '--disable-autodetect', '--disable-programs',
    '--disable-doc', '--disable-debug', '--disable-network', '--disable-static',
    '--enable-shared', '--disable-avdevice',
    '--enable-decoder=aac,aac_fixed,aac_latm,mp3,mp3float',
    '--enable-parser=aac,aac_latm,mpegaudio', cwd=build)
run('make', '-C', build, '-j', args.j)
run('make', '-C', build, 'install')
plugin = work / 'darwin-gst-libav-runtime'
build = work / 'darwin-gst-libav-build'
reconfigure = ['--reconfigure'] if (build / 'meson-private/coredata.dat').exists() else []
run(args.meson, 'setup', *reconfigure, build, work / 'gst-libav-1.28.7',
    '--prefix', plugin, '--libdir', 'lib', '--wrap-mode=nofallback',
    '-Dauto_features=disabled', '-Dpkg_config_path=' + str(ffmpeg / 'lib/pkgconfig') + ',' +
    output('pkg-config', '--variable=pcfiledir', 'gstreamer-1.0'))
run('ninja', '-C', build, '-j', args.j)
run('ninja', '-C', build, 'install')

files = {}
for name in ('avcodec.62', 'avfilter.11', 'avformat.62', 'avutil.60', 'swresample.6', 'swscale.9'):
    source = (ffmpeg / ('lib/lib' + name + '.dylib')).resolve(strict=True)
    files[source] = prefix / ('lib/lib' + name + '.dylib')
files[(plugin / 'lib/gstreamer-1.0/libgstlibav.dylib').resolve(strict=True)] = prefix / 'lib/gstreamer-1.0/libgstlibav.dylib'
for source, target in files.items():
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    command = ['install_name_tool', '-id', str(target)]
    for line in output('otool', '-L', source).splitlines()[1:]:
        dependency = line.strip().split(' (compatibility version')[0]
        resolved = Path(dependency).resolve() if dependency.startswith('/') else None
        if resolved in files:
            command += ['-change', dependency, str(files[resolved])]
    for path in dict.fromkeys(re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset', output('otool', '-l', source))):
        command += ['-delete_rpath', path]
    run(*command, target)
    run('codesign', '--force', '--sign', '-', target)
licenses = prefix / 'share/wpe-webkit-2.0/media-licenses'
licenses.mkdir(parents=True, exist_ok=True)
shutil.copy2(work / 'ffmpeg-8.1.2/COPYING.LGPLv2.1', licenses / 'FFmpeg-LGPL-2.1.txt')
shutil.copy2(work / 'gst-libav-1.28.7/COPYING', licenses / 'GStreamer-libav-COPYING.txt')
print('Installed decoder-only AAC/MP3 supplement:', prefix)
