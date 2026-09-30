#!/usr/bin/env python3
"""Exercise the private libepoxy Darwin dylib dispatcher with a test EGL library.

This tests symbol loading only, not graphics or a real EGL context.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, default=root / 'build-wpe-deps/darwin-prefix')
args = parser.parse_args()
prefix = args.prefix.resolve()
with tempfile.TemporaryDirectory(prefix='wpe-egl-dispatch-') as directory:
    directory = Path(directory)
    library = directory / 'egl.c'
    library.write_text('''#include <stdint.h>
#include <EGL/egl.h>
EGLDisplay eglGetCurrentDisplay(void) { return (EGLDisplay)(uintptr_t)0x1234; }
''')
    client = directory / 'client.c'
    client.write_text('''#include <stdint.h>
#include <epoxy/egl.h>
int main(void) {
    if (!epoxy_has_egl()) return 1;
    return eglGetCurrentDisplay() == (EGLDisplay)(uintptr_t)0x1234 ? 0 : 2;
}
''')
    subprocess.check_call(['clang', '-dynamiclib', '-I' + str(prefix / 'include'),
                           str(library), '-o', str(directory / 'libEGL.dylib')])
    subprocess.check_call(['clang', '-I' + str(prefix / 'include'), str(client),
                           '-L' + str(prefix / 'lib'), '-lepoxy', '-o', str(directory / 'client')])
    subprocess.check_call([str(directory / 'client')], env=dict(os.environ,
        DYLD_LIBRARY_PATH=str(directory) + ':' + str(prefix / 'lib')))
print('PASS opt-in Darwin EGL dispatch (test library; no rendering claim)')
