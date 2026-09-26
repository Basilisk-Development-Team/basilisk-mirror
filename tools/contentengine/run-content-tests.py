#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Run isolated frame, network-policy or WebRTC fixtures against a completed copied distribution."""
import argparse, json, os, shutil, signal, subprocess, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):self.do_GET()
 def do_GET(self):
  from urllib.parse import urlparse,parse_qs
  from collections import Counter
  if not hasattr(self.server,'counts'):self.server.counts=Counter()
  if self.path=='/counts':
   data=json.dumps(self.server.counts).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  self.server.counts[self.path]+=1
  if self.path.startswith('/matrix'):
   run=parse_qs(urlparse(self.path).query)['run'][0];port=self.server.server_port
   resources=lambda host,prefix: ''.join('<script src="%s/%s/script?run=%s"></script><img src="%s/%s/image?run=%s"><link rel="stylesheet" href="%s/%s/style?run=%s"><iframe src="%s/%s/frame?run=%s"></iframe>'%(host,prefix,run,host,prefix,run,host,prefix,run,host,prefix,run))
   body='<!doctype html><title>Loading</title><body><div id="target">Cosmetic</div>'+resources('','deny')+resources('','allow')+resources('http://localhost:%d'%port,'third')
   body+="""<script>
    let jobs=[];for(let prefix of ['deny','allow']) {
      jobs.push(fetch('/'+prefix+'/fetch?run=RUN').catch(()=>{}));
      jobs.push(new Promise(resolve=>{let x=new XMLHttpRequest();x.open('GET','/'+prefix+'/xhr?run=RUN');x.onloadend=resolve;x.send();}));
      jobs.push(new Promise(resolve=>{let ws=new WebSocket('ws://127.0.0.1:PORT/'+prefix+'/socket?run=RUN');ws.onerror=resolve;ws.onclose=resolve;ws.onopen=()=>ws.close();}));
    }
    jobs.push(fetch('/deny/post?run=RUN',{method:'POST'}).catch(()=>{}));
    jobs.push(fetch('/deny/get?run=RUN').catch(()=>{}));
    jobs.push(fetch('/redirect?run=RUN').catch(()=>{}));
    Promise.all(jobs).then(()=>document.title='Matrix ready');
   </script>""".replace('RUN',run).replace('PORT',str(port))
   data=body.encode();self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  if self.path.startswith('/redirect?'):
   self.send_response(302);self.send_header('Location',self.path.replace('/redirect?','/deny/redirect-target?'));self.end_headers();return
  if self.path.startswith(('/deny/','/allow/','/third/')):
   if '/socket?' in self.path and self.headers.get('Upgrade','').lower()=='websocket':
    import base64,hashlib
    accept=base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    self.protocol_version='HTTP/1.1';self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade');self.send_header('Sec-WebSocket-Accept',accept);self.end_headers()
    try:self.wfile.write(bytes([0x88,0]));self.wfile.flush()
    except (BrokenPipeError,ConnectionResetError):pass
    self.close_connection=True;return
   if '/script?' in self.path:data=b"document.body.dataset.script='loaded';";mime='application/javascript'
   elif '/style?' in self.path:data=b'body {background:white}';mime='text/css'
   elif '/image?' in self.path:
    import base64
    data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=');mime='image/png'
   else:data=b'<!doctype html><title>Resource</title>';mime='text/html'
   self.send_response(400 if '/socket?' in self.path else 200);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers()
   try:self.wfile.write(data)
   except (BrokenPipeError,ConnectionResetError):pass
   return
  body='<!doctype html><title>Content fixture</title><body><div id="target">Target</div><script src="/page-script"></script>'
  if self.path.startswith('/page-script'): body="document.body.dataset.pageStart=String(document.documentElement.getAttribute('data-start'));"
  elif self.path.startswith('/frames'):
   body += '<iframe src="/child"></iframe><iframe src="http://localhost:%d/child"></iframe>'%self.server.server_port
  mime='application/javascript' if self.path.startswith('/page-script') else 'text/html'
  data=body.encode();self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store')
  if self.path.startswith('/csp'):self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'none'; style-src 'none'")
  self.send_header('Content-Length',str(len(data)));self.end_headers()
  try:self.wfile.write(data)
  except (BrokenPipeError,ConnectionResetError):pass

def kill_webprocesses(parent):
 parents,commands={},{}
 for proc in Path('/proc').iterdir():
  if not proc.name.isdecimal():continue
  try:
   pid=int(proc.name);parents[pid]=int((proc/'stat').read_text().rsplit(')',1)[1].split()[1]);commands[pid]=(proc/'cmdline').read_bytes().split(b'\0')[0]
  except (OSError,ValueError):pass
 descendants={parent}
 while True:
  found={pid for pid,ppid in parents.items() if ppid in descendants}
  if found<=descendants:break
  descendants |= found
 for pid in descendants:
  if commands.get(pid,b'').endswith(b'/WPEWebProcess'):
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass

p=argparse.ArgumentParser(description=__doc__);p.add_argument('objdir',type=Path);p.add_argument('suite',choices=['webrtc','frames','network','legacy']);p.add_argument('--cycles',type=int,default=3);p.add_argument('--gst-debug');p.add_argument('--external',action='store_true');a=p.parse_args()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 with tempfile.TemporaryDirectory(prefix='basilisk-content-test-') as temporary:
  root=Path(temporary);app=root/'distribution/application';shutil.copytree(a.objdir.resolve()/'dist/bin',app,symlinks=False)
  fixture=Path(__file__).resolve().parent/a.suite;shutil.copytree(fixture,app/'content-test')
  with (app/'chrome.manifest').open('a') as f:f.write('\ncontent content-test content-test/\n')
  profile=root/'profile';profile.mkdir()
  if a.suite=='legacy':
   shutil.copytree(fixture/'extension',profile/'extensions/legacy-runtime-test@basilisk-browser.org')
   second=profile/'extensions/legacy-other-test@basilisk-browser.org'
   shutil.copytree(fixture/'extension',second)
   for name in ['install.rdf','bootstrap.js']:
    path=second/name
    path.write_text(path.read_text().replace('legacy-runtime-test','legacy-other-test').replace('legacyFixture','legacyOtherFixture'))
  prefs={'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,'browser.shell.checkDefaultBrowser':False,'browser.dom.window.dump.enabled':True,'content.test.port':server.server_port,'content.test.cycles':a.cycles,'content.test.external':a.external}
  (profile/'user.js').write_text('\n'.join('user_pref(%s,%s);'%(json.dumps(k),json.dumps(v)) for k,v in prefs.items()))
  env={k:v for k,v in os.environ.items() if not k.startswith(('LD_','WEBKIT_','WPE_','GST_'))}
  env['GST_REGISTRY_1_0']=str(root/'gst-registry.bin')
  if a.gst_debug:env['GST_DEBUG']=a.gst_debug
  process=subprocess.Popen([str(app/'basilisk'),'-no-remote','-profile',str(profile),'-chrome','chrome://content-test/content/test.xul'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
  timer=threading.Timer(max(300,a.cycles*10),process.kill);timer.start();output=[]
  try:
   for line in process.stdout:
    print(line,end='',flush=True);output.append(line)
    if 'CONTENT-TEST KILL WebProcesses' in line:kill_webprocesses(process.pid)
   process.wait()
  finally:
   timer.cancel()
   try:os.killpg(process.pid,signal.SIGTERM)
   except ProcessLookupError:pass
  raise SystemExit(0 if process.returncode==0 and any('CONTENT-TEST PASS all' in line for line in output) else 1)
finally:server.shutdown();server.server_close()
