#!/usr/bin/env python3
"""Exercise the versioned state reader against the pinned unmodified XPI."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

xpi = Path(sys.argv[1])
expected = '9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf'
if hashlib.sha256(xpi.read_bytes()).hexdigest() != expected:
    sys.exit('Unsupported test XPI: expected pinned 1.16.6.1 package')
with tempfile.TemporaryDirectory(prefix='ublock-state-test-') as temporary:
    root = Path(temporary)
    with zipfile.ZipFile(xpi) as archive:
        for name in ('utils.js', 'hntrie.js', 'static-net-filtering.js', 'dynamic-net-filtering.js',
                     'url-net-filtering.js', 'hnswitches.js'):
            # Exact fixed members only; never extract arbitrary archive paths.
            member = next(n for n in archive.namelist() if n.endswith('/js/' + name) or n == 'js/' + name)
            target = root / 'js' / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(archive.read(member))
    subprocess.run(['node', str(Path(__file__).with_name('test-state.js')), str(root)] + sys.argv[2:], check=True)
assert hashlib.sha256(xpi.read_bytes()).hexdigest() == expected
