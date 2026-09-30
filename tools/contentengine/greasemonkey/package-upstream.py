#!/usr/bin/env python3
"""Package an unchanged upstream Greasemonkey source archive for local audits.

No source or manifest rewriting, signing, or production installation is done.
"""
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import tarfile
import zipfile

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive',type=Path)
parser.add_argument('output',type=Path)
args=parser.parse_args()
with tarfile.open(args.archive) as source,zipfile.ZipFile(args.output,'w') as output:
    for entry in sorted(source.getmembers(),key=lambda item:PurePosixPath(item.name).parts):
        if entry.isdir():continue
        if not entry.isfile():raise ValueError('Non-regular archive member: '+entry.name)
        parts=PurePosixPath(entry.name).parts
        if len(parts)<2 or '..' in parts or parts[0].startswith('/'):
            raise ValueError('Invalid archive path: '+entry.name)
        info=zipfile.ZipInfo('/'.join(parts[1:]),(2017,10,1,0,0,0))
        output.writestr(info,source.extractfile(entry).read())
print('Archive SHA256 '+hashlib.sha256(args.archive.read_bytes()).hexdigest())
print('XPI SHA256 '+hashlib.sha256(args.output.read_bytes()).hexdigest())
