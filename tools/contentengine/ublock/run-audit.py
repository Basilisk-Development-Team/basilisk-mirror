#!/usr/bin/env python3
"""Audit an unmodified user-supplied legacy uBlock XPI in a disposable profile."""
import argparse
from contextlib import nullcontext
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
        from urllib.parse import urlparse, parse_qs
        from collections import Counter
        import base64
        import hashlib
        if not hasattr(self.server, 'counts'): self.server.counts = Counter()
        if self.path == '/counts':
            body = json.dumps(self.server.counts).encode(); mime = 'application/json'
        else:
            self.server.counts[self.path] += 1
            print('SERVER REQUEST ' + self.path, flush=True)
            engine = parse_qs(urlparse(self.path).query).get('engine', ['unknown'])[0]
            if self.path.startswith('/audit-redirect?'):
                self.send_response(302)
                self.send_header('Location', '/audit-blocked-redirect?engine=' + engine)
                self.end_headers()
                return
            if '-socket?' in self.path and self.headers.get('Upgrade', '').lower() == 'websocket':
                key = self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
                self.protocol_version = 'HTTP/1.1'
                self.send_response(101)
                self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
                self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
                self.end_headers()
                try: self.wfile.write(bytes([0x88, 0])); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError): pass
                self.close_connection = True
                return
            if self.path.startswith('/page?'):
                third = 'http://localhost:%d' % self.server.server_port
                body = "<!doctype html><meta charset=utf-8><title>Loading</title><body data-load='%d'><div class='audit-ad'>Cosmetic target</div><div class='basilisk-audit-generic'>Generic cosmetic</div><div class='basilisk-audit-exception'>Excepted cosmetic</div>" % self.server.counts[self.path]
                for prefix in ('audit-blocked', 'audit-allowed'):
                    body += "<script src='/%s.js?engine=%s'></script>" % (prefix, engine)
                    body += "<script src='%s/%s-third-script?engine=%s'></script>" % (third, prefix, engine)
                    body += "<img src='/%s-image?engine=%s'><link rel='stylesheet' href='/%s-style?engine=%s'><iframe src='/%s-frame?engine=%s'></iframe>" % (prefix, engine, prefix, engine, prefix, engine)
                body += """<script>
                let jobs=[];
                for(let prefix of ['audit-blocked','audit-allowed']) {
                  jobs.push(fetch('/'+prefix+'-fetch?engine=ENGINE').catch(()=>{}));
                  jobs.push(new Promise(resolve=>{let x=new XMLHttpRequest();x.open('GET','/'+prefix+'-xhr?engine=ENGINE');x.onloadend=resolve;x.send();}));
                  jobs.push(new Promise(resolve=>{let ws=new WebSocket('ws://127.0.0.1:PORT/'+prefix+'-socket?engine=ENGINE');ws.onerror=resolve;ws.onclose=resolve;ws.onopen=()=>ws.close();}));
                }
                jobs.push(fetch('/audit-redirect?engine=ENGINE').catch(()=>{}));
                let e=document.createElement('div');e.className='audit-ad dynamic';document.body.appendChild(e);
                Promise.all(jobs).then(()=>document.title='Audit page');
                </script></body>""".replace('ENGINE',engine).replace('PORT',str(self.server.server_port))
                body=body.encode(); mime='text/html'
            elif self.path.startswith(('/audit-blocked', '/audit-allowed')):
                allowed = self.path.startswith('/audit-allowed')
                if '.js?' in self.path:
                    body=("document.body.setAttribute('data-%s','loaded');" % ('allowed' if allowed else 'external')).encode(); mime='application/javascript'
                elif '-third-script?' in self.path:
                    body=("document.body.setAttribute('data-third-%s','loaded');" % ('allowed' if allowed else 'external')).encode(); mime='application/javascript'
                elif '-style?' in self.path: body=b'body {background-color: white}'; mime='text/css'
                elif '-image?' in self.path:
                    body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII='); mime='image/png'
                else: body=b'<!doctype html><title>Resource</title>'; mime='text/html'
            else: body=b''; mime='text/plain'
        self.send_response(200); self.send_header('Content-Type',mime); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('objdir',type=Path);parser.add_argument('xpi',type=Path)
    parser.add_argument('--require-webkit', action='store_true', help='Require WebKit network, cosmetic, page-state, reload, picker and logger acceptance probes')
    parser.add_argument('--site', default='', help='Also navigate each engine to this diagnostic site without changing its filters')
    parser.add_argument('--switches',type=int,default=0,help='Additional Gecko/WebKit/Gecko cycles with server-counter checks')
    parser.add_argument('--restarts',type=int,default=0,help='Repeat the audit with the same disposable profile to measure persistent filter reuse')
    parser.add_argument('--keep-profile',action='store_true',help='Keep the disposable profile for diagnosing a failed restart')
    parser.add_argument('--debugger',action='store_true',help='Run under gdb and capture a crash backtrace')
    args=parser.parse_args()
    if not 0<=args.restarts<=5:parser.error('--restarts must be between 0 and 5')
    if not 0<=args.switches<=1000:parser.error('--switches must be between 0 and 1000')
    obj=args.objdir.resolve();chrome=obj/'dist/bin/browser/chrome/browser/content/browser/contentengine'
    original_hash=hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    print('XPI SHA256 '+original_hash,flush=True)
    import zipfile, xml.etree.ElementTree as ET
    with zipfile.ZipFile(args.xpi) as archive:
        manifest=ET.fromstring(archive.read('install.rdf'))
        print('XPI VERSION '+manifest.find('.//{http://www.mozilla.org/2004/em-rdf#}version').text,flush=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();staged=[]
    try:
        for suffix in ('js','xul'):
            target=chrome/('content-ublock-audit.'+suffix);target.symlink_to(Path(__file__).resolve().parent/('audit.'+suffix));staged.append(target)
        profile_context=nullcontext(tempfile.mkdtemp(prefix='basilisk-ublock-audit-')) if args.keep_profile else tempfile.TemporaryDirectory(prefix='basilisk-ublock-audit-')
        with profile_context as profile:
            if args.keep_profile:print('UBLOCK-AUDIT PROFILE '+profile,flush=True)
            extensions=Path(profile,'extensions');extensions.mkdir();shutil.copy2(args.xpi,extensions/'uBlock0@raymondhill.net.xpi')
            prefs={'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,'browser.dom.window.dump.enabled':True,'browser.shell.checkDefaultBrowser':False,'content.audit.port':server.server_port,'content.audit.requireWebKit':args.require_webkit,'content.audit.site':args.site,'content.audit.switches':args.switches}
            for run in range(args.restarts+1):
                print('UBLOCK-AUDIT RUN '+str(run),flush=True)
                prefs['content.audit.restarted']=run>0
                if hasattr(server,'counts'):server.counts.clear()
                Path(profile,'user.js').write_text('\n'.join('user_pref(%s,%s);'%(json.dumps(k),json.dumps(v)) for k,v in prefs.items()))
                command=[str(obj/'dist/bin/basilisk'),'-no-remote','-profile',profile,'-chrome','chrome://browser/content/contentengine/content-ublock-audit.xul']
                if args.debugger:
                    command=['gdb','--batch','-ex','set pagination off','-ex','handle SIGPIPE nostop noprint pass','-ex','run','-ex','bt 40','--args']+command
                result=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
                watchdog=threading.Timer(180+10*args.switches,result.kill);watchdog.start();output=[]
                try:
                    for line in result.stdout:
                        output.append(line);print(line,end='',flush=True)
                    result.wait()
                finally: watchdog.cancel()
                assert hashlib.sha256(args.xpi.read_bytes()).hexdigest() == original_hash, 'source XPI changed'
                assert hashlib.sha256((extensions/'uBlock0@raymondhill.net.xpi').read_bytes()).hexdigest() == original_hash, 'installed XPI changed'
                if (result.returncode or not any('UBLOCK-AUDIT COMPLETE' in line for line in output)
                    or any('Barrier: quit-application-granted' in line or 'GLib-CRITICAL' in line for line in output)):return 1
            return 0

    finally:
        for path in staged:path.unlink()
        server.shutdown();server.server_close()
if __name__=='__main__':raise SystemExit(main())
