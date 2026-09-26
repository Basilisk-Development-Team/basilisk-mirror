#!/usr/bin/env python3
"""Audit an unmodified user-supplied legacy uBlock XPI in a disposable profile."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.startswith('/audit-blocked.js'):
            print('SERVER REQUEST '+self.path, flush=True)
            body=b"document.body.setAttribute('data-external','loaded');"; mime='application/javascript'
        else:
            body=b"<!doctype html><meta charset=utf-8><title>Audit page</title><body><div class='audit-ad'>Cosmetic target</div><script src='/audit-blocked.js'></script></body>"; mime='text/html'
        self.send_response(200); self.send_header('Content-Type',mime); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('objdir',type=Path);parser.add_argument('xpi',type=Path);args=parser.parse_args()
    obj=args.objdir.resolve();chrome=obj/'dist/bin/browser/chrome/browser/content/browser/contentengine'
    print('XPI SHA256 '+hashlib.sha256(args.xpi.read_bytes()).hexdigest(),flush=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();staged=[]
    try:
        for suffix in ('js','xul'):
            target=chrome/('content-ublock-audit.'+suffix);target.symlink_to(Path(__file__).resolve().parent/('audit.'+suffix));staged.append(target)
        with tempfile.TemporaryDirectory(prefix='basilisk-ublock-audit-') as profile:
            extensions=Path(profile,'extensions');extensions.mkdir();shutil.copy2(args.xpi,extensions/'uBlock0@raymondhill.net.xpi')
            prefs={'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,'browser.dom.window.dump.enabled':True,'browser.shell.checkDefaultBrowser':False,'content.audit.port':server.server_port}
            Path(profile,'user.js').write_text('\n'.join('user_pref(%s,%s);'%(json.dumps(k),json.dumps(v)) for k,v in prefs.items()))
            result=subprocess.run([str(obj/'dist/bin/basilisk'),'-no-remote','-profile',profile,'-chrome','chrome://browser/content/contentengine/content-ublock-audit.xul'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
            print(result.stdout,end='');return 0 if result.returncode==0 and 'UBLOCK-AUDIT COMPLETE' in result.stdout else 1
    finally:
        for path in staged:path.unlink()
        server.shutdown();server.server_close()
if __name__=='__main__':raise SystemExit(main())
