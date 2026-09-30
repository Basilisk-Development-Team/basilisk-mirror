#!/usr/bin/env python3
"""Copy the WPE Darwin runtime and its non-system Mach-O dependencies.

Only distribution copies are rewritten. The installed SDK, MacPorts libraries
and source checkout are never modified. Ad-hoc signing permits local execution
of rewritten Apple Silicon images; this is not release signing/notarization.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

# Deliberately bounded software-media set. Do not copy the host's plugin tree:
# it may contain unrelated device, network, display and codec backends. Missing
# required entries fail packaging. H.264/AAC support is not implied by this set.
MEDIA_PLUGINS = (
    'coreelements', 'typefindfunctions', 'app', 'playback', 'audioconvert',
    'audioresample', 'autodetect', 'osxaudio', 'wavparse', 'matroska', 'vpx',
    'opus', 'ogg', 'vorbis', 'theora', 'videoconvertscale', 'volume', 'isomp4', 'audiofx',
)
MEDIA_EXTRAS = ('applemedia', 'videoparsersbad', 'debugutilsbad', 'subenc')


def output(*args):
    return subprocess.check_output(args, text=True)


def system(name):
    return name.startswith(('/System/Library/', '/usr/lib/'))


def names(path):
    return [line.strip().split(' (compatibility version')[0]
            for line in output('otool', '-L', str(path)).splitlines()[1:]]


def identity(path):
    lines = output('otool', '-D', str(path)).splitlines()
    return lines[1].strip() if len(lines) > 1 else None


def rpaths(path):
    return re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset',
                      output('otool', '-l', str(path)))


def stage(prefix, dist, bridge, gio, ca_file=Path('/opt/local/share/curl/curl-ca-bundle.crt')):
    dist.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.wpe-darwin-', dir=dist.parent) as directory:
        temporary = Path(directory).resolve()
        root = temporary / 'webkit'
        root.mkdir()
        images = {}
        destinations = {}
        pending = []

        def copy(source, destination=None):
            source = source.resolve(strict=True)
            if source in images:
                return images[source]
            if destination is None:
                destination = Path('lib') / Path(identity(source) or source.name).name
            destination = root / destination
            if destination in destinations and destinations[destination] != source:
                raise RuntimeError('Conflicting runtime library: ' + str(destination))
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            images[source] = destination
            destinations[destination] = source
            pending.append(source)
            return destination

        def resolve(name, owner):
            if name.startswith('@loader_path/'):
                return owner.parent / name[len('@loader_path/'):]
            if name.startswith('@rpath/'):
                suffix = name[len('@rpath/'):]
                candidates = [prefix / 'lib' / suffix]
                for entry in rpaths(owner):
                    if entry.startswith('@loader_path'):
                        entry = entry.replace('@loader_path', str(owner.parent), 1)
                    if entry.startswith('/'):
                        candidates.append(Path(entry) / suffix)
                for candidate in candidates:
                    if candidate.is_file():
                        return candidate
                raise RuntimeError('Unresolved SDK dependency: %s: %s' % (owner, name))
            if name.startswith('/'):
                return Path(name)
            raise RuntimeError('Unsupported SDK dependency: %s: %s' % (owner, name))

        engine = prefix / 'lib/libWPEWebKit-2.0.dylib'
        copy(engine)
        media = any(Path(name).name.startswith('libgstreamer-1.0.') for name in names(engine))
        if media:
            plugins = Path(output('pkg-config', '--variable=pluginsdir', 'gstreamer-1.0').strip())
            scanner = Path(output('pkg-config', '--variable=pluginscannerdir', 'gstreamer-1.0').strip())
            for name in MEDIA_PLUGINS:
                filename = 'libgst' + name + '.dylib'
                copy(plugins / filename, Path('lib/gstreamer-1.0') / filename)
            extras = prefix / 'lib/gstreamer-1.0'
            if any((extras / ('libgst' + name + '.dylib')).exists() for name in MEDIA_EXTRAS):
                # A supplementary SDK is an explicit bounded set, not a scan
                # of whatever plugins happen to be installed on the machine.
                for name in MEDIA_EXTRAS:
                    filename = 'libgst' + name + '.dylib'
                    copy(extras / filename, Path('lib/gstreamer-1.0') / filename)
            if (extras / 'libgstlibav.dylib').exists():
                copy(extras / 'libgstlibav.dylib', Path('lib/gstreamer-1.0/libgstlibav.dylib'))
            copy(scanner / 'gst-plugin-scanner', Path('libexec/gst-plugin-scanner'))
        for helper in ('WPEWebProcess', 'WPENetworkProcess'):
            copy(prefix / 'libexec/wpe-webkit-2.0' / helper, Path('libexec') / helper)
        copy(prefix / 'lib/wpe-webkit-2.0/injected-bundle/libWPEInjectedBundle.so',
             Path('injected-bundle/libWPEInjectedBundle.so'))
        copy(bridge, Path('extensions/libbasilisk-content-extension.so'))
        copy(gio, Path('lib/gio/modules') / gio.name)
        shutil.copytree(prefix / 'share/wpe-webkit-2.0', root / 'share')
        if not (root / 'share/inspector.gresource').is_file():
            raise RuntimeError('Missing installed Inspector resource')
        (root / 'lib/modules').mkdir()
        edges = {}
        while pending:
            source = pending.pop()
            own_name = identity(source)
            edges[source] = []
            for name in names(source):
                if name == own_name or system(name):
                    continue
                dependency = copy(resolve(name, source))
                edges[source].append((name, dependency))

        for source, destination in images.items():
            command = ['install_name_tool']
            if identity(source):
                command += ['-id', '@rpath/' + destination.name]
            for old, dependency in edges[source]:
                command += ['-change', old, '@loader_path/' + os.path.relpath(dependency, destination.parent)]
            for entry in dict.fromkeys(rpaths(source)):
                command += ['-delete_rpath', entry]
            if len(command) > 1:
                subprocess.run(command + [str(destination)], check=True)
            subprocess.run(['codesign', '--force', '--sign', '-', str(destination)], check=True,
                           stdout=subprocess.DEVNULL)
        subprocess.run(['gio-querymodules', str(root / 'lib/gio/modules')], check=True)
        shutil.copy2(ca_file, root / 'share/ca-bundle.pem')
        fontconfig = root / 'share/fontconfig'
        fontconfig.mkdir()
        (fontconfig / 'fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>
<dir>~/Library/Fonts</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>
''')
        (root / 'share/basilisk-build.ini').write_text(
            '[Build]\nENABLE_WEB_RTC=false\nUSE_GSTREAMER_WEBRTC=false\n'
            'USE_GSTREAMER=%s\n' % str(media).lower())
        # Audit dependency resolution before replacing an existing distribution.
        for source, destination in images.items():
            own_name = identity(destination)
            for name in names(destination):
                if name == own_name or system(name):
                    continue
                if not name.startswith('@loader_path/'):
                    raise RuntimeError('Nonrelocatable staged dependency: ' + name)
                resolved = (destination.parent / name[len('@loader_path/'):]).resolve()
                if root not in resolved.parents or not resolved.is_file():
                    raise RuntimeError('Unresolved staged dependency: ' + name)
        runtime = dist / 'webkit'
        if runtime.exists():
            shutil.rmtree(runtime)
        root.rename(runtime)
        print('Staged WPE Darwin runtime: %d relocated Mach-O images' % len(images))


def relocate_frontend(dist):
    image = dist / 'XUL'
    if not image.is_file():
        return  # Standalone runtime fixtures have no XUL image.
    replacement = dist / '.XUL.wpe-relocated'
    shutil.copy2(image.resolve(), replacement)
    try:
        command = ['install_name_tool']
        own_name = identity(replacement)
        for name in names(replacement):
            if name == own_name or system(name):
                continue
            bundled = dist / 'webkit/lib' / Path(name).name
            if bundled.is_file():
                command += ['-change', name, '@rpath/' + bundled.name]
            elif name.startswith('/'):
                raise RuntimeError('Unbundled XUL dependency: ' + name)
        existing = set(rpaths(replacement))
        for entry in existing:
            if not entry.startswith(('@loader_path', '@executable_path')):
                command += ['-delete_rpath', entry]
        for entry in ('@loader_path/webkit/lib', '@loader_path/../Resources/webkit/lib'):
            if entry not in existing:
                command += ['-add_rpath', entry]
        if len(command) > 1:
            subprocess.run(command + [str(replacement)], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(replacement)], check=True,
                       stdout=subprocess.DEVNULL)
        os.replace(replacement, image)  # Replace a distribution symlink, never its object target.
    finally:
        if replacement.exists():
            replacement.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, required=True)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--bridge', type=Path)
    parser.add_argument('--gio-module', type=Path)
    parser.add_argument('--ca-file', type=Path, default=Path('/opt/local/share/curl/curl-ca-bundle.crt'))
    args = parser.parse_args()
    dist = args.dist.resolve()
    bridge = args.bridge or dist.parent / 'contentengine-backends/libbasilisk-content-extension.dylib'
    gio = args.gio_module or Path(output('pkg-config', '--variable=giomoduledir', 'gio-2.0').strip()) / 'libgiognutls.so'
    stage(args.prefix.resolve(), dist, bridge, gio, args.ca_file)
    relocate_frontend(dist)


if __name__ == '__main__':
    main()
