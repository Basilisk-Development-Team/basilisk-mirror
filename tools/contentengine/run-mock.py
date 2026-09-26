#!/usr/bin/env python3
"""Register a non-rendering JS XPCOM content backend in a fresh test process only."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
obj = Path(sys.argv[1]).resolve()
chrome = obj / 'dist/bin/browser/chrome/browser/content/browser/contentengine'
staged = []
try:
    for suffix in ('js', 'xul'):
        target = chrome / ('content-mock-test.' + suffix)
        target.symlink_to(Path(__file__).resolve().parent / ('mock.' + suffix))
        staged.append(target)
    with tempfile.TemporaryDirectory(prefix='basilisk-content-mock-') as profile:
        Path(profile, 'user.js').write_text('user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.dom.window.dump.enabled", true);\n')
        result = subprocess.run([str(obj / 'dist/bin/basilisk'), '-no-remote', '-profile', profile,
                                 '-chrome', 'chrome://browser/content/contentengine/content-mock-test.xul'],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=90)
        print(result.stdout, end='')
        sys.exit(0 if result.returncode == 0 and 'CONTENT-MOCK PASS' in result.stdout and 'CONTENT-MOCK FAIL' not in result.stdout else 1)
finally:
    for target in staged: target.unlink()
