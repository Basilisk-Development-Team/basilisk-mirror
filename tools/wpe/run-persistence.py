#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Restart an enabled browser with one profile; verify WPE data and private isolation.
Requires DISPLAY and the WPE loader path. Do not run during an object-dir build.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        script = """
        async function db() {
          return new Promise((resolve, reject) => {
            let r=indexedDB.open('wpe-test',1);
            r.onupgradeneeded=()=>r.result.createObjectStore('state');
            r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
          });
        }
        async function run() {
          let store=await db();
          let write=location.pathname.startsWith('/write');
          let privateWrite=location.pathname=='/write-private';
          let tx=store.transaction('state',write?'readwrite':'readonly');
          let table=tx.objectStore('state');
          if(write) {
            document.cookie='wpeTest='+(privateWrite?'private':'cookie')+'; Max-Age=86400; Path=/';
            localStorage.setItem('wpeTest',privateWrite?'private':'local');
            table.put(privateWrite?'private':'indexed','test');
            tx.oncomplete=()=>{store.close();document.title=privateWrite?'Private stored':'Stored';};
          } else {
            let r=table.get('test');
            r.onsuccess=()=>{
              let c=document.cookie.match(/(?:^|; )wpeTest=([^;]+)/);
              document.title='Read:'+(c?c[1]:'none')+':'+(localStorage.getItem('wpeTest')||'none')+':'+(r.result||'none');
            };
            tx.oncomplete=()=>store.close();
          }
        }
        run().catch(e=>document.title='ERROR '+e);
        """
        page = ("<!doctype html><meta charset=utf-8><title>Loading</title><script>" + script + "</script>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("objdir", type=Path)
    args = parser.parse_args()
    binary = args.objdir.resolve() / "dist/bin/basilisk"
    chrome = binary.parent / "browser/chrome/browser/content/browser/webkit"
    if not (chrome / "engine-session.js").is_file():
        parser.error("requires an unpackaged enabled build with session integration")
    fixtures = Path(__file__).resolve().parent / "persistence"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    staged = []
    try:
        for suffix in ("js", "xul"):
            target = chrome / ("wpe-persistence-test." + suffix)
            target.symlink_to(fixtures / ("persistence." + suffix))
            staged.append(target)
        with tempfile.TemporaryDirectory(prefix="basilisk-wpe-persistent-") as profile:
            for phase in ("write", "read"):
                prefs = {"browser.shell.checkDefaultBrowser": False,
                         "browser.startup.page": 0,
                         "browser.tabs.warnOnClose": False,
                         "browser.dom.window.dump.enabled": True,
                         "wpe.test.port": server.server_port, "wpe.test.phase": phase}
                Path(profile, "user.js").write_text("\n".join(
                    "user_pref(%s, %s);" % (json.dumps(k), json.dumps(v)) for k, v in prefs.items()))
                result = subprocess.run([str(binary), "-no-remote", "-profile", profile,
                    "-chrome", "chrome://browser/content/webkit/wpe-persistence-test.xul"],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=150)
                print(result.stdout, end="", flush=True)
                if result.returncode or "WPE-PERSISTENCE PASS " + phase not in result.stdout or "WPE-PERSISTENCE FAIL" in result.stdout:
                    return 1
            if not Path(profile, "webkit/cookies.sqlite").is_file():
                raise RuntimeError("WPE cookies were not stored beneath the Basilisk profile")
            print("PASS: profile-owned persistent data, mixed restore, private isolation")
        return 0
    finally:
        for path in staged:
            path.unlink()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
