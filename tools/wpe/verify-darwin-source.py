#!/usr/bin/env python3
"""Verify the full-source Darwin checkout against its explicit patch series.

Uses an isolated Git index; never modifies the source checkout or its index.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path,
                    default=root / 'build-wpe-deps/WebKit-darwin-upstream')
args = parser.parse_args()
source = args.source.resolve()
metadata = root / 'third_party/webkit/darwin'
revision = json.loads((metadata / 'upstream.json').read_text())['revision']

def git(*arguments, env=None):
    return subprocess.check_output(['git', '-C', str(source), *arguments], env=env)

if git('rev-parse', 'HEAD').decode().strip() != revision:
    raise SystemExit('Source HEAD differs from the pinned Darwin revision')
patchdir = metadata / 'patches'
series = [line.strip() for line in (patchdir / 'series').read_text().splitlines()
          if line.strip() and not line.lstrip().startswith('#')]
if len(set(series)) != len(series) or any(Path(name).name != name for name in series):
    raise SystemExit('Invalid or duplicate patch name')
if set(series) != {path.name for path in patchdir.glob('*.patch')}:
    raise SystemExit('Patch inventory differs from series')
with tempfile.TemporaryDirectory(prefix='wpe-darwin-index-') as temporary:
    env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
    git('read-tree', revision, env=env)
    common = root / 'third_party/webkit/patches'
    shared = [line.strip() for line in (common / 'series').read_text().splitlines()
              if line.strip() and not line.lstrip().startswith('#')]
    for patch in [common / name for name in shared] + [patchdir / name for name in series]:
        git('apply', '--cached', '--check', str(patch), env=env)
        git('apply', '--cached', str(patch), env=env)
    options = ('--binary', '--no-ext-diff', '--no-textconv', '--no-renames')
    expected = git('diff', '--cached', *options, revision, env=env)
    # A normal `git apply` leaves newly added patch files untracked. Construct
    # a second temporary index from tracked changes and all untracked paths,
    # rather than requiring the developer to stage vendor-source modifications.
    changed = git('diff', '--name-only', '-z', revision).split(b'\0')
    extras = git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0')
    paths = sorted({path.decode() for path in changed + extras if path})
    actual_env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'actual-index'))
    git('read-tree', revision, env=actual_env)
    for path in paths:
        git('add', '-A', '--', path, env=actual_env)
    actual = git('diff', '--cached', *options, revision, env=actual_env)
    if actual != expected:
        raise SystemExit('Source differs from the pinned revision plus documented patches')
print('PASS WPE Darwin source: pinned revision plus %d upstream-branch and %d Darwin patches' % (len(shared), len(series)))
