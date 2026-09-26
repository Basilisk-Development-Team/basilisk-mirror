#!/usr/bin/env python3
"""Reject platform embedding dependencies above the content backend boundary."""
from pathlib import Path
import re
root = Path(__file__).resolve().parents[2]
paths = list((root / 'basilisk/base/content/contentengine').glob('*'))
paths += [p for p in (root / 'basilisk/components/contentengine').glob('*') if p.suffix in ('.cpp', '.h', '.idl')]
errors = []
for path in paths:
    if not path.is_file(): continue
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if re.search(r'\b(?:WPE\w*|WebKitWeb\w*|Gtk\w*|Gdk\w*|WKWebView|XP_MACOSX|XP_WIN)\b|<wpe/|\bwpe[-_]|\bwebkit_\w+', line):
            errors.append('%s:%d: %s' % (path.relative_to(root), number, line))
if errors: raise SystemExit('\n'.join(errors))
print('PASS: shared content shim/chrome has no platform embedding types or switches')
