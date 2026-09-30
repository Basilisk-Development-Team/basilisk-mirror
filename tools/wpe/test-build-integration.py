#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Test the real make prerequisites and pinned-source preparation lifecycle."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]
prepare = runpy.run_path(str(ROOT / 'tools/wpe/prepare-source.py'))['prepare']
verify = runpy.run_path(str(ROOT / 'tools/wpe/verify-source.py'))['verify']


class BuildIntegration(unittest.TestCase):
    def test_parallel_consumers_wait_and_failure_propagates(self):
        with TemporaryDirectory(prefix='wpe-make-') as temporary:
            base = Path(temporary)
            helper = base / 'tools/wpe/build-runtime.py'
            helper.parent.mkdir(parents=True)
            helper.write_text('''
import os
from pathlib import Path
import sys
with open('events', 'a') as output: output.write('build\\n')
if os.environ.get('FAIL_WPE'): sys.exit(1)
Path('ready').touch()
''')
            consumers = ['basilisk/components/contentengine/wpe/target',
                         'basilisk/components/contentengine/wpe/extension/target']
            makefile = base / 'Makefile'
            makefile.write_text('''
.PHONY: all
all: %s
WPE_BUILD_FROM_SOURCE = 1
WPE_SOURCE_ROOT = %s
WPE_BUILD_DIR = %s/build
WPE_RUNTIME_PREFIX = %s/stage/usr
PYTHON = %s
include %s/basilisk/build.mk
%s:
\t@test -f ready
\t@echo consumer >> events
''' % (' '.join(consumers), base, base, base, sys.executable, ROOT, ' '.join(consumers)))
            subprocess.check_call(['make', '-s', '-j8', 'all'], cwd=base)
            self.assertEqual((base / 'events').read_text().splitlines(), ['build', 'consumer', 'consumer'])
            (base / 'events').unlink()
            (base / 'ready').unlink()
            result = subprocess.run(['make', '-s', '-j8', 'all'], cwd=base,
                                    env=dict(os.environ, FAIL_WPE='1'), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((base / 'events').read_text().splitlines(), ['build'])
            (base / 'events').unlink()
            # An explicit prebuilt runtime / disabled configuration must not
            # invoke the helper, even if it would fail.
            (base / 'ready').touch()
            subprocess.check_call(['make', '-s', '-j8', 'all', 'WPE_BUILD_FROM_SOURCE='], cwd=base,
                                  env=dict(os.environ, FAIL_WPE='1'))
            self.assertEqual((base / 'events').read_text().splitlines(), ['consumer', 'consumer'])

    def test_fetch_patch_verify_and_preserve_existing_source(self):
        # The real source cache lives beneath the application's Git worktree.
        with TemporaryDirectory(prefix='.wpe-source-test-', dir=ROOT) as temporary:
            base = Path(temporary)
            vendor = base / 'vendor'
            patches = vendor / 'patches'
            patches.mkdir(parents=True)
            patch = patches / 'fix.patch'
            patch.write_text('''diff --git a/file b/file
--- a/file
+++ b/file
@@ -1 +1 @@
-original
+patched
''')
            (patches / 'series').write_text('fix.patch\n')
            remote = base / 'upstream.tar.gz'
            with tarfile.open(remote, 'w:gz') as tar:
                entry = tarfile.TarInfo('wpe-test/file')
                entry.size = len(b'original\n')
                tar.addfile(entry, io.BytesIO(b'original\n'))
            pin = dict(version='test', directory='wpe-test', url=remote.as_uri(),
                       sha256=hashlib.sha256(remote.read_bytes()).hexdigest())
            (vendor / 'upstream.json').write_text(json.dumps(pin))
            archive, source = base / 'cache/archive.tar.gz', base / 'cache/source'
            prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'patched\n')
            previous = Path.cwd()
            previous_tempdir = tempfile.tempdir
            try:
                os.chdir(ROOT / 'basilisk')
                tempfile.tempdir = str(base)
                self.assertEqual(verify(source, archive, pin, [patch]), 1)
            finally:
                tempfile.tempdir = previous_tempdir
                os.chdir(previous)
            # Offline reuse neither downloads nor reapplies the patch.
            remote.unlink()
            prepare(source, archive, vendor)
            self.assertEqual(verify(source, archive, pin, [patch]), 1)
            # A revised patch is applied by preparation at build time. It must
            # verify the previous recorded series before replacing any file.
            patch.write_text(patch.read_text().replace('+patched', '+updated'))
            prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'updated\n')
            self.assertEqual(verify(source, archive, pin, [patch]), 1)
            unchanged_mtime = (source / 'file').stat().st_mtime_ns
            prepare(source, archive, vendor)
            self.assertEqual((source / 'file').stat().st_mtime_ns, unchanged_mtime)
            # Removing a patch restores its upstream bytes through the same
            # verified preparation path, without manual source-tree edits.
            (patches / 'series').write_text('')
            patch.rename(patches / 'fix.saved')
            prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'original\n')
            (patches / 'fix.saved').rename(patch)
            (patches / 'series').write_text('fix.patch\n')
            prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'updated\n')
            (source / 'file').write_text('local modification\n')
            prepare(source, archive, vendor)
            with self.assertRaisesRegex(ValueError, 'Source differs'):
                verify(source, archive, pin, [patch])
            self.assertEqual((source / 'file').read_text(), 'local modification\n')
            patch.write_text(patch.read_text().replace('+updated', '+third'))
            with self.assertRaisesRegex(ValueError, 'Source differs'):
                prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'local modification\n')
            archive.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                prepare(source, archive, vendor)
            self.assertEqual((source / 'file').read_text(), 'local modification\n')


if __name__ == '__main__':
    unittest.main()
