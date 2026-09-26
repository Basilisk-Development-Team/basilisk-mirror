#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Audit and launch a relocated distribution with the checkout hidden.

Requires DISPLAY, bubblewrap and strace. Uses trusted local build ELF files only.
The browser receives no LD_LIBRARY_PATH, LD_PRELOAD or build environment. The
checkout (including the dependency install prefix) is masked in its mount namespace.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import tempfile
import threading

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = b'<!doctype html><title>Relocated content</title><h1>Relocated content</h1><input value="Native WPE surface"><p>Packaged libraries, helpers and resources.</p>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

def audit(dist, env):
    count = 0
    for path in sorted(dist.rglob('*')):
        if not path.is_file(): continue
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF': continue
        count += 1
        dynamic = subprocess.check_output(['readelf', '-d', str(path)], text=True, env=env)
        for line in dynamic.splitlines():
            if '(NEEDED)' in line and '/' in line.split('[')[-1]:
                raise RuntimeError('Absolute ELF dependency: ' + str(path))
            if '(RPATH)' in line or '(RUNPATH)' in line:
                paths = line.split('[')[-1].split(']')[0].split(':')
                if any(not item.startswith('$ORIGIN') for item in paths):
                    raise RuntimeError('Nonrelocatable loader path: ' + str(path))
        if '(NEEDED)' in dynamic:
            result = subprocess.run(['ldd', str(path)], stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, env=env)
            if result.returncode or 'not found' in result.stdout:
                raise RuntimeError('Unresolved ELF: %s\n%s' % (path, result.stdout))
            for line in result.stdout.splitlines():
                if re.search(r'lib(?:WPE|wpe|webkit)', line, re.I) and str(dist) not in line:
                    raise RuntimeError('External WebKit dependency: ' + line)
    print('PASS: %d shipped ELF files resolve without LD_LIBRARY_PATH' % count, flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('location', type=Path, help='Object directory, or extracted application with --packaged')
    parser.add_argument('--packaged', action='store_true', help='Test an extracted installer application')
    parser.add_argument('--log', type=Path, required=True)
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parents[2]
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='basilisk-relocated-') as temporary:
            root = Path(temporary)
            dist = root / 'distribution/application'
            source = args.location.resolve() if args.packaged else args.location.resolve() / 'dist/bin'
            shutil.copytree(source, dist, symlinks=False)
            for name in ('tmp', 'runtime'):
                (root / name).mkdir(mode=0o700)
            env = {'PATH':'/usr/bin:/bin', 'HOME':str(root), 'LANG':'C.UTF-8',
                   'DISPLAY':os.environ['DISPLAY'], 'XDG_CACHE_HOME':str(root / 'cache'),
                   'XDG_CONFIG_HOME':str(root / 'config'), 'XDG_DATA_HOME':str(root / 'data'),
                   'TMPDIR':str(root / 'tmp'), 'XDG_RUNTIME_DIR':str(root / 'runtime')}
            if os.environ.get('XAUTHORITY'): env['XAUTHORITY'] = os.environ['XAUTHORITY']
            audit(dist, env)
            # A separate test-only chrome package also works with packaged omni.ja.
            chrome = dist / 'runtime-test'
            chrome.mkdir()
            with (dist / 'chrome.manifest').open('a') as manifest:
                manifest.write('\ncontent basilisk-runtime-test runtime-test/\n')
            for suffix in ('js', 'xul'):
                shutil.copy2(Path(__file__).parent / 'runtime' / ('runtime.' + suffix),
                             chrome / ('runtime-test.' + suffix))
            shutil.copy2(checkout / 'tools/contentengine/webrtc/content.js', chrome / 'webrtc.js')
            profile = root / 'profile'
            profile.mkdir()
            prefs = {'browser.shell.checkDefaultBrowser':False, 'browser.dom.window.dump.enabled':True,
                     'browser.startup.page':0, 'runtime.test.port':server.server_port}
            (profile / 'user.js').write_text('\n'.join('user_pref(%s, %s);' %
                (json.dumps(k), json.dumps(v)) for k,v in prefs.items()))
            trace = root / 'files.trace'
            # Keep the normal system runtime but hide every checkout/build path.
            command = ['bwrap', '--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/',
                       '--bind', temporary, temporary, '--dev-bind', '/dev', '/dev',
                       '--proc', '/proc', '--tmpfs', str(checkout),
                       'strace', '-f', '-qq', '-e', 'trace=file', '-o', str(trace),
                       str(dist / 'basilisk'), '-no-remote', '-profile', str(profile),
                       '-chrome', 'chrome://basilisk-runtime-test/content/runtime-test.xul']
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, env=env, cwd=temporary, start_new_session=True)
            output = []
            def kill_test():
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            watchdog = threading.Timer(180, kill_test)
            watchdog.start()
            try:
                for line in process.stdout:
                    output.append(line)
                    if 'WPE-RUNTIME INSPECTOR OPEN' in line:
                        # Capture the actual upstream frontend, not just its XUL host.
                        threading.Event().wait(10)
                        subprocess.run(['import', '-display', env['DISPLAY'], '-window', 'root',
                                        str(args.log.resolve()) + '.png'], env=env, timeout=15)
                process.wait(timeout=15)
            finally:
                watchdog.cancel()
                if process.poll() is None: kill_test(); process.wait()
            text = ''.join(output)
            args.log.write_text(text)
            print(text, end='')
            trace_text = trace.read_text(errors='replace')
            shutil.copy2(trace, str(args.log) + '.trace')
            forbidden = [line for line in trace_text.splitlines() if str(checkout) in line]
            if forbidden: raise RuntimeError('Runtime accessed checkout: ' + '\n'.join(forbidden[:10]))
            for helper in ('WPEWebProcess', 'WPENetworkProcess'):
                if not re.search(r'execve\("' + re.escape(str(dist / 'webkit/libexec' / helper)), trace_text):
                    raise RuntimeError('Packaged helper did not execute: ' + helper)
            if process.returncode or 'WPE-RUNTIME PASS ' not in text or 'WPE-RUNTIME FAIL ' in text:
                raise RuntimeError('Relocated browser smoke test failed')
            print('PASS: copied runtime launched with checkout hidden; helpers/resources stayed application-local')
    finally:
        server.shutdown()
        server.server_close()

if __name__ == '__main__': main()
