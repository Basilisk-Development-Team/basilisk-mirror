#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Prepare verified upstream sources and apply the current downstream series.

Updates require the existing tree to match its recorded series exactly. Never
repair local edits. Preserve unchanged files so patch updates build incrementally.
"""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import urllib.request


def prepare(source, archive, vendor):
    pin = json.loads((vendor / 'upstream.json').read_text())
    verifier = runpy.run_path(str(Path(__file__).with_name('verify-source.py')))
    patches = verifier['patch_series'](vendor / 'patches')
    state = source.parent / ('.' + source.name + '-series.json')
    desired = {'sha256': pin['sha256'], 'patches': [p.read_text() for p in patches]}
    source.parent.mkdir(parents=True, exist_ok=True)
    archive.parent.mkdir(parents=True, exist_ok=True)
    # Object directories can share this immutable source cache. Extraction and
    # patching become visible only after both have completed successfully.
    with (source.parent / '.wpe-source.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not archive.exists():
            with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as output:
                download = Path(output.name)
                try:
                    print('Downloading pinned WPE ' + pin['version'], flush=True)
                    with urllib.request.urlopen(pin['url'], timeout=60) as response:
                        shutil.copyfileobj(response, output)
                    output.close()
                    if hashlib.sha256(download.read_bytes()).hexdigest() != pin['sha256']:
                        raise ValueError('Pinned upstream archive SHA-256 mismatch')
                    download.replace(archive)
                finally:
                    download.unlink(missing_ok=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin['sha256']:
            raise ValueError('Pinned upstream archive SHA-256 mismatch')
        if source.exists():
            if state.exists():
                previous = json.loads(state.read_text())
                if previous['sha256'] != pin['sha256']:
                    raise ValueError('Upstream pin changed; use a new source/build directory')
                if previous == desired:
                    return  # The build wrapper still verifies the complete tree.
                with tempfile.TemporaryDirectory(prefix='wpe-previous-series-') as temporary:
                    old_patches = []
                    for index, contents in enumerate(previous['patches']):
                        path = Path(temporary) / ('%04d.patch' % index)
                        path.write_text(contents)
                        old_patches.append(path)
                    verifier['verify'](source, archive, pin, old_patches, True)
            else:
                # Migrate an older, verified cache. Accept only an exact prefix
                # of this series, never reverse or guess at local modifications.
                for count in range(len(patches), -1, -1):
                    try:
                        verifier['verify'](source, archive, pin, patches[:count], True)
                        break
                    except ValueError:
                        if not count:
                            raise
                if count == len(patches):
                    state.write_text(json.dumps(desired))
                    return
        with tempfile.TemporaryDirectory(prefix='.wpe-source-', dir=source.parent) as temporary:
            subprocess.check_call(['tar', '-xf', str(archive), '-C', temporary])
            extracted = Path(temporary) / pin['directory']
            environment = verifier['git_environment'](extracted)
            for patch in patches:
                subprocess.check_call(['git', 'apply', '--check', str(patch)], cwd=extracted, env=environment)
                subprocess.check_call(['git', 'apply', str(patch)], cwd=extracted, env=environment)
            if source.exists():
                before = verifier['inventory'](source)
                after = verifier['inventory'](extracted)
                # Source is exclusively locked; active builds hold a shared
                # lock. Only differences produced by the patch series change.
                for name in sorted(set(before) | set(after)):
                    if before.get(name) == after.get(name):
                        continue
                    target = source / name
                    if name not in after:
                        target.unlink()
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        replacement = target.with_name(target.name + '.wpe-replacement')
                        shutil.copy2(extracted / name, replacement, follow_symlinks=False)
                        replacement.replace(target)
            else:
                extracted.rename(source)
            pending = state.with_suffix('.tmp')
            pending.write_text(json.dumps(desired))
            pending.replace(state)


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source.resolve(), args.archive.resolve(), root / 'third_party/webkit')
