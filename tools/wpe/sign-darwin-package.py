#!/usr/bin/env python3
"""Refresh local arm64 code signatures after packaging strips Mach-O files.

This is ad-hoc execution metadata, not distribution signing/notarization.
Only the staged app is modified. An externally configured signing command owns
release signing instead of this fallback.
"""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
args = parser.parse_args()
app = args.app.resolve(strict=True)
if not (app / 'Contents/MacOS/basilisk').is_file():
    raise RuntimeError('Not a staged Basilisk application: ' + str(app))
images = []
for path in app.rglob('*'):
    if not path.is_file():
        continue
    if not path.resolve().is_relative_to(app):
        raise RuntimeError('External staging symlink: ' + str(path))
    with path.open('rb') as stream:
        if stream.read(4) in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'):
            images.append(path)
for image in images:
    subprocess.run(['codesign', '--force', '--sign', '-', str(image)], check=True)
# Seal nested bundles before their parent. No --deep traversal or modification
# of source/object-directory symlink targets is permitted.
for bundle in sorted(app.rglob('*.app'), key=lambda path: len(path.parts), reverse=True) + [app]:
    subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], check=True)
for image in images:
    subprocess.run(['codesign', '--verify', str(image)], check=True)
print('Refreshed staged application: %d Mach-O images' % len(images))
