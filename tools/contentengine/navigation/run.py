#!/usr/bin/env python3
"""Drive real XUL navigation, including native keyboard input, in a fresh profile."""
import argparse,json,os,shutil,subprocess,tempfile,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  body=('<!doctype html><title>'+self.path+'</title><h1>'+self.path+'</h1><input>').encode()
  self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
p=argparse.ArgumentParser();p.add_argument('objdir',type=Path);p.add_argument('--cycles',type=int,default=3);p.add_argument('--https',action='store_true');a=p.parse_args()
temporary=tempfile.TemporaryDirectory(prefix='basilisk-navigation-runtime-')
root=Path(temporary.name)/'application'
shutil.copytree(a.objdir.resolve()/'dist/bin',root,symlinks=False)
chrome=root/'navigation-test';chrome.mkdir()
with (root/'chrome.manifest').open('a') as manifest: manifest.write('\ncontent navigation-test navigation-test/\n')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
staged=[]
try:
 for suffix in ('js','xul'):
  target=chrome/('navigation-test.'+suffix);target.symlink_to(Path(__file__).resolve().parent/('test.'+suffix));staged.append(target)
 with tempfile.TemporaryDirectory(prefix='basilisk-navigation-') as profile:
  prefs={'browser.shell.checkDefaultBrowser':False,'browser.dom.window.dump.enabled':True,'navigation.test.port':server.server_port,'navigation.test.cycles':a.cycles,'navigation.test.https':a.https,'browser.search.suggest.enabled':False}
  Path(profile,'user.js').write_text('\n'.join('user_pref(%s,%s);'%(json.dumps(k),json.dumps(v)) for k,v in prefs.items()))
  process=subprocess.Popen([str(root/'basilisk'),'-no-remote','-profile',profile,'-chrome','chrome://navigation-test/content/navigation-test.xul'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  timer=threading.Timer(max(240,a.cycles*8),process.kill);timer.start();output=[]
  try:
   for line in process.stdout:
    print(line,end='',flush=True);output.append(line)
    if line.startswith(('NAVIGATION INPUT ','NAVIGATION PASTE ','NAVIGATION FOCUS ')):
     uri=line.strip().split(' ',2)[2]
     ids=[]
     for attempt in range(30):
      found=subprocess.run(['xdotool','search','--onlyvisible','--pid',str(process.pid)],stdout=subprocess.PIPE,text=True).stdout.split()
      for candidate in found:
       name=subprocess.check_output(['xdotool','getwindowname',candidate],text=True).strip()
       if name=='Navigation driver' or ' - Basilisk' in name:ids.append(candidate)
      if ids:break
      time.sleep(.1)
     if not ids:raise RuntimeError('Native browser window not found; candidates '+repr(found))
     subprocess.check_call(['xdotool','windowfocus','--sync',ids[-1],'key','--clearmodifiers','ctrl+l'])
     if line.startswith('NAVIGATION FOCUS '):continue
     if line.startswith('NAVIGATION PASTE '): subprocess.check_call(['xdotool','key','--clearmodifiers','ctrl+v'])
     else: subprocess.check_call(['xdotool','type','--clearmodifiers','--delay','20',uri])
     subprocess.check_call(['xdotool','key','--clearmodifiers','Return'])
   process.wait()
  finally:
   timer.cancel()
   if process.poll() is None:process.kill();process.wait()
  raise SystemExit(0 if process.returncode==0 and any('NAVIGATION PASS' in x for x in output) else 1)
finally:
 for target in staged:target.unlink()
 server.shutdown();server.server_close();temporary.cleanup()
