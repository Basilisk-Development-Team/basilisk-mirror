#!/usr/bin/env python3
"""Link the already built WPEPlatform/WTF/bmalloc objects into a tiny consumer.

This catches foundation link/lifetime failures before the full engine finishes.
No browser or rendering claim follows from this test.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, default=root / 'build-wpe-deps/darwin-full-build')
parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/WebKit-darwin-upstream')
parser.add_argument('--prefix', type=Path, default=root / 'build-wpe-deps/darwin-prefix')
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--cocoa', action='store_true', help='Test the Cocoa SHM presentation adapter')
mode.add_argument('--stream', action='store_true', help='Test the actual GLib IPC stream reader')
mode.add_argument('--ipc', action='store_true', help='Test the actual patched Darwin IPC semaphore')
parser.add_argument('--asan', action='store_true', help='Instrument the test/adapter, not prebuilt WebKit objects')
args = parser.parse_args()
build, source, prefix = args.build.resolve(), args.source.resolve(), args.prefix.resolve()
objects = []
ninja = shutil.which('ninja') or '/opt/local/bin/ninja'
targets = subprocess.check_output([ninja, '-C', str(build), '-t', 'targets', 'all'], text=True)
active = [line.rsplit(': ', 1)[0] for line in targets.splitlines()]
for name in ('Source/WTF/wtf/CMakeFiles/WTF.dir',
             'Source/bmalloc/CMakeFiles/bmalloc.dir',
             'Source/WebKit/WPEPlatform/CMakeFiles/WPEPlatform.dir',
             'Source/WebKit/WPEPlatform/wpe/headless/CMakeFiles/WPEPlatformHeadless.dir'):
    # Do not accidentally include stale objects from an earlier source list.
    group = sorted(build / target for target in active
                   if target.startswith(name + '/') and target.endswith('.o'))
    if not group:
        raise SystemExit('Build WTF and WPEPlatform first: missing ' + name)
    if any(not path.is_file() for path in group):
        raise SystemExit('Build WTF and WPEPlatform first: incomplete ' + name)
    objects.extend(group)
env = dict(os.environ, PKG_CONFIG_PATH=str(prefix / 'lib/pkgconfig') + ':/opt/local/lib/pkgconfig')
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs',
    'gio-2.0', 'gobject-2.0', 'epoxy', 'xkbcommon', 'icu-i18n', 'icu-uc'], env=env, text=True))
with tempfile.TemporaryDirectory(prefix='wpe-darwin-platform-') as directory:
    directory = Path(directory)
    library, executable = directory / 'platform.a', directory / 'platform-test'
    subprocess.check_call(['/usr/bin/libtool', '-static', '-o', str(library), *map(str, objects)])
    sources = [root / 'tools/wpe/darwin-platform-smoke.cpp']
    extra = []
    if args.cocoa:
        host = root / 'basilisk/components/contentengine/wpe/darwin'
        sources = [root / 'tools/wpe/darwin-cocoa-surface-test.mm',
                   host / 'WPECocoaSurface.mm', host / 'WPECocoaClipboard.mm', host / 'WPEGLibRunLoop.mm']
        extra += ['-I' + str(host), '-framework', 'AppKit']
    if args.asan:
        extra += ['-fsanitize=address', '-fno-omit-frame-pointer']
    if args.ipc or args.stream:
        database = json.loads((build / 'compile_commands.json').read_text())
        units = [
            ('semaphore', 'UnifiedSource-Platform-4.cpp',
             source / 'Source/WebKit/Platform/IPC/unix/IPCSemaphoreUnix.cpp'),
            ('memory-unix', 'UnifiedSource-platform-82.cpp',
             source / 'Source/WebCore/platform/unix/SharedMemoryUnix.cpp'),
            ('memory', 'UnifiedSource-platform-10.cpp',
             source / 'Source/WebCore/platform/SharedMemory.cpp'),
            ('test', 'UnifiedSource-Platform-4.cpp', root / 'tools/wpe/darwin-ipc-semaphore-test.cpp'),
        ]
        if args.stream:
            units = [('stream-test', 'UnifiedSource-Platform-4.cpp', root / 'tools/wpe/darwin-ipc-stream-test.cpp')]
        sources = []
        for name, reference, path in units:
            entry = next(item for item in database if item['file'].endswith('/' + reference))
            command = shlex.split(entry['command'])
            output = directory / (name + '.o')
            command[command.index('-o') + 1] = str(output)
            command[command.index('-c') + 1] = str(path)
            # Preserve the exact engine ABI/configuration, but write only into
            # this temporary directory, never over Ninja's object outputs.
            command += extra
            if subprocess.run(command, cwd=entry['directory']).returncode:
                raise SystemExit('Failed to compile IPC fixture unit: ' + name)
            sources.append(output)
        extra += ['-Wl,-dead_strip']
    subprocess.check_call(['clang++', '-std=c++17', *extra,
        '-I' + str(source / 'Source/WebKit/WPEPlatform'),
        '-I' + str(build / 'DerivedSources/WPEPlatform'),
        *map(str, sources), str(library), *flags,
        '-framework', 'Foundation', '-framework', 'CoreFoundation', '-lz', '-o', str(executable)])
    subprocess.check_call([str(executable)])
