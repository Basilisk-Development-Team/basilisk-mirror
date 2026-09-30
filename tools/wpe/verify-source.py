#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Verify pinned upstream archive + ordered patches == bundled source.

Verification is read-only for the source under test. Expected patch results are
constructed in a temporary tree, not inferred from reverse-applying the series
against potentially dirty source. Unexpected files, modes and symlinks fail.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git_environment(directory):
    # TMPDIR can itself be inside the application's worktree. Keep git apply
    # independent of both enclosing repositories and caller Git overrides.
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(directory).resolve().parent))
    for name in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        environment.pop(name, None)
    return environment


def safe_path(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or '.git' in path.parts or '\\' in name:
        raise ValueError('Unsafe path: ' + name)
    return path


def patch_series(directory):
    patches = []
    for line in (directory / 'series').read_text().splitlines():
        name = line.partition('#')[0].strip()
        if not name:
            continue
        path = directory / safe_path(name)
        if path.suffix != '.patch' or path.is_symlink() or not path.is_file():
            raise ValueError('Expected a regular .patch file: ' + str(path))
        if path in patches:
            raise ValueError('Duplicate patch: ' + name)
        patches.append(path)
    unlisted = set(directory.rglob('*.patch')) - set(patches)
    if unlisted:
        raise ValueError('Unlisted patches: ' + ', '.join(map(str, sorted(unlisted))))
    return patches


def describe(path):
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        return ('link', os.readlink(path))
    if stat.S_ISREG(mode):
        return ('file', digest(path.read_bytes()), bool(mode & 0o111))
    raise ValueError('Unsupported source node: ' + str(path))


def inventory(directory):
    result = {}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        # A symlink to a directory is a source entry, never a traversal target.
        links = [name for name in dirs if (Path(parent) / name).is_symlink()]
        dirs[:] = [name for name in dirs if name not in links]
        for name in files + links:
            path = Path(parent) / name
            result[path.relative_to(directory).as_posix()] = describe(path)
    return result


def expected_tree(archive, pin, patches):
    if digest(archive.read_bytes()) != pin['sha256']:
        raise ValueError('Pinned upstream archive SHA-256 mismatch')
    touched = set()
    # Disable rename detection: downstream patches use explicit add/delete hunks.
    for patch in patches:
        if re.search(rb'^(?:new file mode|old mode|new mode) (?:120000|160000)$', patch.read_bytes(), re.M):
            raise ValueError('Symlink/gitlink patches unsupported: ' + str(patch))
        # git apply filters paths when invoked beneath a repository's root.
        # mach invokes us from the object directory, so inspect patches outside
        # any repository just as we do when applying them to the sparse tree.
        with tempfile.TemporaryDirectory(prefix='wpe-patch-inventory-') as directory:
            output = subprocess.check_output(
                ['git', 'apply', '--numstat', '-z', str(patch)], cwd=directory,
                env=git_environment(directory))
        for entry in output.split(b'\0'):
            if not entry:
                continue
            fields = entry.decode().split('\t', 2)
            if len(fields) != 3 or not fields[2] or fields[0] == '-':
                raise ValueError('Rename/binary patch format unsupported: ' + str(patch))
            touched.add(str(safe_path(fields[2])))
    expected = {}
    with tempfile.TemporaryDirectory(prefix='wpe-expected-source-') as temporary:
        sparse = Path(temporary)
        with tarfile.open(archive, 'r|*') as source:
            for member in source:
                parts = safe_path(member.name).parts
                if parts[0] != pin['directory']:
                    raise ValueError('Unexpected archive root: ' + member.name)
                name = PurePosixPath(*parts[1:]).as_posix()
                if member.isdir():
                    continue
                # The pinned release repeats some generated resources. Match
                # normal extraction: the final member at a path wins.
                if member.isfile():
                    data = source.extractfile(member).read()
                    expected[name] = ('file', digest(data), bool(member.mode & 0o111))
                    if name in touched:
                        target = sparse / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(data)
                        target.chmod(0o755 if member.mode & 0o111 else 0o644)
                elif member.issym():
                    expected[name] = ('link', member.linkname)
                    # Patching symlinks or their children is intentionally unsupported.
                    if any(path == name or path.startswith(name + '/') for path in touched):
                        raise ValueError('Patch touches an upstream symlink: ' + name)
                else:
                    raise ValueError('Unsupported archive member: ' + member.name)
        for patch in patches:
            subprocess.check_call(['git', 'apply', '--check', '--whitespace=error-all', str(patch)],
                                  cwd=sparse, env=git_environment(sparse))
            subprocess.check_call(['git', 'apply', '--whitespace=error-all', str(patch)],
                                  cwd=sparse, env=git_environment(sparse))
        actual_patch_tree = inventory(sparse)
        if set(actual_patch_tree) - touched:
            raise ValueError('Patch wrote an undeclared path')
        for name in touched:
            if name in actual_patch_tree:
                expected[name] = actual_patch_tree[name]
            else:
                expected.pop(name, None)
    return expected


def verify(source, archive, pin, patches, allow_python_cache=False):
    expected = expected_tree(archive, pin, patches)
    actual = inventory(source)
    if allow_python_cache:
        for name in list(set(actual) - set(expected)):
            path=PurePosixPath(name)
            match=re.fullmatch(r'(.+)\.cpython-[0-9]+(?:\.opt-[0-9]+)?\.pyc',path.name)
            original=(path.parent.parent / (match.group(1)+'.py')).as_posix() if match else None
            if path.parent.name=='__pycache__' and match and original in expected and actual[name][0]=='file':
                del actual[name]
    failures = []
    for name in sorted(set(actual) | set(expected)):
        if actual.get(name) != expected.get(name):
            category = 'extra' if name not in expected else 'missing' if name not in actual else 'changed'
            failures.append(category + ': ' + name)
    if failures:
        raise ValueError('Source differs from pinned archive + series (%d differences):\n' % len(failures) + '\n'.join(failures[:50]))
    return len(expected)


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=root / 'build-wpe-deps/wpewebkit-2.54.0')
    parser.add_argument('--archive', type=Path, default=root / 'build-wpe-deps/downloads/wpewebkit-2.54.0.tar.xz')
    parser.add_argument('--vendor', type=Path, default=root / 'third_party/webkit')
    parser.add_argument('--allow-python-cache', action='store_true', help='Permit generated CPython cache files only for verified source .py files')
    args = parser.parse_args()
    try:
        pin = json.loads((args.vendor / 'upstream.json').read_text())
        patches = patch_series((args.vendor / 'patches').resolve())
        count = verify(args.source.resolve(), args.archive.resolve(), pin, patches, args.allow_python_cache)
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')
    print('PASS: %d source entries match WPE %s + %d documented patches' % (count, pin['version'], len(patches)))
    if args.allow_python_cache:
        print('Generated CPython caches for verified source modules excluded; no source files excluded')


if __name__ == '__main__':
    main()
