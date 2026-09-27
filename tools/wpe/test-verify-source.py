#!/usr/bin/env python3
"""Small synthetic archives exercise source verification without a WebKit build."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify_source', Path(__file__).with_name('verify-source.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceVerification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'file').write_text('original\n')
        (self.source / 'link').symlink_to('file')
        self.archive = self.root / 'upstream.tar'
        with tarfile.open(self.archive, 'w') as archive:
            entry = tarfile.TarInfo('upstream/file')
            entry.mode = 0o644
            entry.size = len(b'original\n')
            archive.addfile(entry, io.BytesIO(b'original\n'))
            link = tarfile.TarInfo('upstream/link')
            link.type = tarfile.SYMTYPE
            link.linkname = 'file'
            archive.addfile(link)
        self.pin = {'directory':'upstream', 'sha256':module.digest(self.archive.read_bytes())}
        self.patches = self.root / 'patches'
        self.patches.mkdir()
        (self.patches / 'series').write_text('')

    def verify(self):
        return module.verify(self.source, self.archive, self.pin, module.patch_series(self.patches))

    def test_pristine(self):
        self.assertEqual(self.verify(), 2)

    def test_archive_pin(self):
        self.pin['sha256'] = 'bad'
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            self.verify()

    def test_changed_extra_missing_and_mode(self):
        file = self.source / 'file'
        file.write_text('unlisted edit\n')
        with self.assertRaisesRegex(ValueError, 'changed: file'):
            self.verify()
        file.write_text('original\n')
        file.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'changed: file'):
            self.verify()
        file.chmod(0o644)
        (self.source / 'extra').write_text('extra')
        with self.assertRaisesRegex(ValueError, 'extra: extra'):
            self.verify()
        (self.source / 'extra').unlink()
        file.unlink()
        with self.assertRaisesRegex(ValueError, 'missing: file'):
            self.verify()

    def test_symlink_target(self):
        (self.source / 'link').unlink()
        (self.source / 'link').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'changed: link'):
            self.verify()

    def test_ordered_series_and_add_delete(self):
        first = self.patches / '0001.patch'
        first.write_text('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-original\n+changed\n')
        second = self.patches / '0002.patch'
        second.write_text('diff --git a/file b/file\ndeleted file mode 100644\n--- a/file\n+++ /dev/null\n@@ -1 +0,0 @@\n-changed\n'
                          'diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+added\n')
        (self.patches / 'series').write_text('0001.patch\n0002.patch\n')
        (self.source / 'file').unlink()
        (self.source / 'new').write_text('added\n')
        self.assertEqual(self.verify(), 2)
        (self.patches / 'series').write_text('0002.patch\n0001.patch\n')
        with self.assertRaises(module.subprocess.CalledProcessError):
            self.verify()

    def test_unlisted_and_duplicate(self):
        (self.patches / 'forgotten.patch').write_text('')
        with self.assertRaisesRegex(ValueError, 'Unlisted'):
            self.verify()
        (self.patches / 'series').write_text('forgotten.patch\nforgotten.patch\n')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.verify()

    def test_known_cache_requires_explicit_option(self):
        with tarfile.open(self.archive,'a') as archive:
            entry=tarfile.TarInfo('upstream/module.py');entry.size=0
            archive.addfile(entry,io.BytesIO(b''))
        self.pin['sha256']=module.digest(self.archive.read_bytes())
        (self.source/'module.py').write_text('')
        cache=self.source/'__pycache__';cache.mkdir()
        (cache/'module.cpython-314.pyc').write_bytes(b'generated output')
        with self.assertRaisesRegex(ValueError,'extra:'):
            self.verify()
        self.assertEqual(module.verify(self.source,self.archive,self.pin,[],True),3)

    def test_arbitrary_cache_not_exempt(self):
        cache=self.source/'__pycache__'
        cache.mkdir()
        (cache/'unknown.cpython-314.pyc').write_bytes(b'not a known module')
        with self.assertRaisesRegex(ValueError,'extra:'):
            module.verify(self.source,self.archive,self.pin,[],True)

    def test_traversal(self):
        (self.patches / 'series').write_text('../escape.patch\n')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
