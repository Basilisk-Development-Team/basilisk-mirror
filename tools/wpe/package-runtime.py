#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Stage the installed WPE runtime and make the ELF distribution relocatable.

Run only on trusted build products. Never alters the installed WPE prefix or
upstream sources. System GTK/GLib/media/graphics libraries remain OS dependencies.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

def elf(path):
    if not path.is_file(): return False
    with path.open('rb') as stream: return stream.read(4) == b'\x7fELF'

def stage(prefix, dist, patchelf):
    library_dirs = [prefix / 'lib', prefix / 'lib64']
    libraries = [p for d in library_dirs for p in d.glob('libWPEWebKit-2.0.so.*') if p.is_file()]
    if not libraries:
        raise RuntimeError('WPE runtime library missing under ' + str(prefix))
    # The upstream helper override is compiled out in release-only WPE builds.
    # Refuse a superficially complete package that would launch build-tree helpers.
    library = libraries[0].read_bytes()
    if b'WEBKIT_EXEC_PATH\0' not in library:
        raise RuntimeError('Rebuild upstream WPE with -DDEVELOPER_MODE=ON (tests may remain OFF); relocatable helper lookup is otherwise compiled out')
    locations = re.findall(rb'(/[\x20-\x7e]+/(?:libexec/wpe-webkit-2\.0|lib(?:64)?/wpe-webkit-2\.0(?:/injected-bundle/)?|lib(?:64)?/wpe-platform-2\.0/modules|share/wpe-webkit-2\.0))\x00', library)
    if not locations or any(not path.startswith(b'/usr/') for path in locations):
        raise RuntimeError('WPE embeds non-system runtime paths; build with a conventional /usr prefix and install using DESTDIR (tools/wpe/build-runtime.py)')
    runtime = dist / 'webkit'
    temporary = Path(tempfile.mkdtemp(prefix='.webkit-runtime-', dir=dist.parent))
    try:
        for name in ('lib', 'lib/modules', 'libexec', 'injected-bundle', 'share'):
            (temporary / name).mkdir()
        # Include every shared library installed in the selected dependency
        # prefix, including any bundled dependency; do not copy developer tools.
        copied = set()
        for directory in library_dirs:
            for source in directory.glob('*.so*'):
                if not elf(source): continue
                real = source.resolve()
                if real in copied: continue
                copied.add(real)
                dynamic = subprocess.check_output(['readelf', '-d', str(real)], text=True)
                soname = re.search(r'\(SONAME\).*\[([^\]]+)\]', dynamic)
                # Ship the runtime SONAME, not several 170-MiB copies of the
                # same library through developer/version symlink aliases.
                name = soname.group(1) if soname else real.name
                if '/' in name: raise RuntimeError('Invalid SONAME: ' + name)
                target = temporary / 'lib' / name
                if target.exists(): raise RuntimeError('Conflicting runtime library: ' + name)
                shutil.copy2(real, target)
            bundle = directory / 'wpe-webkit-2.0/injected-bundle'
            if bundle.is_dir(): shutil.copytree(bundle, temporary / 'injected-bundle', dirs_exist_ok=True)
            modules = directory / 'wpe-platform-2.0/modules'
            if modules.is_dir(): shutil.copytree(modules, temporary / 'lib/modules', dirs_exist_ok=True)
        helpers = prefix / 'libexec/wpe-webkit-2.0'
        for source in helpers.iterdir():
            if source.is_file(): shutil.copy2(source, temporary / 'libexec' / source.name)
        shutil.copytree(prefix / 'share/wpe-webkit-2.0', temporary / 'share', dirs_exist_ok=True)
        for required in ('libexec/WPEWebProcess', 'libexec/WPENetworkProcess',
                         'injected-bundle/libWPEInjectedBundle.so', 'share/inspector.gresource'):
            if not (temporary / required).is_file(): raise RuntimeError('Missing WPE runtime file: ' + required)
        if runtime.exists(): shutil.rmtree(runtime)
        temporary.rename(runtime)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    count = 0
    seen = set()
    # Patch distribution copies, never symlink targets in an object/dependency
    # directory. This also makes plugin/container/NSS ELF audits self-contained.
    for path in sorted(dist.rglob('*')):
        if not elf(path): continue
        if path.is_symlink():
            data = path.resolve()
            try:
                data.relative_to(dist)
                continue # An application-local SONAME alias is already portable.
            except ValueError:
                pass
            replacement = path.with_name(path.name + '.runtime-copy')
            shutil.copy2(data, replacement)
            os.replace(replacement, path)
        if path in seen: continue
        seen.add(path)
        dynamic = subprocess.check_output(['readelf', '-d', str(path)], text=True)
        if '(NEEDED)' not in dynamic: continue
        to_root = os.path.relpath(dist, path.parent)
        root = '$ORIGIN' if to_root == '.' else '$ORIGIN/' + to_root
        rpath = ':'.join(dict.fromkeys(('$ORIGIN', root, root + '/webkit/lib')))
        subprocess.check_call([patchelf, '--set-rpath', rpath, str(path)])
        count += 1
    print('Staged WPE helpers/resources/libraries; relocated %d ELF files' % count)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, required=True)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--patchelf', required=True)
    args = parser.parse_args()
    stage(args.prefix.resolve(), args.dist.resolve(), args.patchelf)
