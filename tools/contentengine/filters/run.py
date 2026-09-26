#!/usr/bin/env python3
"""Exercise generic request policies, registration transfer and stale replies."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.startswith('/page'):
            body = '''<!doctype html><title>Loading</title><body>
<script src="/blocked.js"></script><script src="/allowed.js"></script>
<script>fetch('/blocked-fetch').then(()=>document.body.dataset.fetch='loaded',
()=>document.body.dataset.fetch='blocked').then(()=>document.title='Ready');</script>'''
            mime = 'text/html'
        else:
            body = "document.body.dataset.%s='yes';" % ('blocked' if self.path.startswith('/blocked') else 'allowed')
            mime = 'application/javascript'
        body = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('objdir', type=Path)
parser.add_argument('--cycles', type=int, default=3)
args = parser.parse_args()
binary = args.objdir.resolve() / 'dist/bin/basilisk'
chrome = binary.parent / 'browser/chrome/browser/content/browser/contentengine'
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
staged = []
try:
    for suffix in ('js', 'xul'):
        target = chrome / ('content-filter-test.' + suffix)
        target.symlink_to(Path(__file__).resolve().parent / ('test.' + suffix))
        staged.append(target)
    with tempfile.TemporaryDirectory(prefix='basilisk-content-filter-') as profile:
        prefs = {'browser.shell.checkDefaultBrowser':False, 'browser.dom.window.dump.enabled':True,
                 'content.test.port':server.server_port, 'content.test.cycles':args.cycles}
        Path(profile, 'user.js').write_text('\n'.join('user_pref(%s, %s);' % (json.dumps(k),json.dumps(v)) for k,v in prefs.items()))
        result = subprocess.run([str(binary), '-no-remote', '-profile', profile, '-chrome',
            'chrome://browser/content/contentengine/content-filter-test.xul'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        print(result.stdout, end='')
        raise SystemExit(0 if result.returncode == 0 and 'CONTENT-FILTER PASS all' in result.stdout else 1)
finally:
    for target in staged: target.unlink()
    server.shutdown()
    server.server_close()
