#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Run isolated WPE multi-tab, Inspector, crash and shutdown stress fixtures.

Requires DISPLAY and a runtime loader path that finds the installed WPE library.
Uses a fresh profile, a loopback HTTP server, and temporary build-only chrome.
Never run concurrently with a build in the same object directory.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/redirect-host":
            self.send_response(302)
            self.send_header("Location", "http://localhost:%d/b" % self.server.server_port)
            self.end_headers()
            return
        title = "Page B" if self.path == "/b" else "Page A"
        if self.path == "/slow":
            time.sleep(2)
            title = "Page Slow"
        page = ("<!doctype html><title>%s %.9f</title><h1>%s</h1>"
                % (title, time.monotonic(), title)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        try:
            self.wfile.write(page)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The delayed request is intentionally cancelled by stop().


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("objdir", type=Path)

    parser.add_argument("--mode", choices=["lifecycle", "shutdown", "switching"], default="lifecycle")
    args = parser.parse_args()
    objdir = args.objdir.resolve()
    binary = objdir / "dist/bin/basilisk"
    chrome = objdir / "dist/bin/browser/chrome/browser/content/browser/webkit"
    if not binary.is_file() or not (chrome / "prototype.xul").is_file():
        parser.error("requires a completed, unpackaged --enable-webkit build")
    name = "stress"
    marker = "WPE-" + name.upper()
    fixture = Path(__file__).resolve().parent / name
    staged = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for suffix in ("js", "xul"):
            destination = chrome / ("wpe-" + name + "-test." + suffix)
            # Refuse to overwrite an existing test or product resource.
            destination.symlink_to(fixture / (name + "." + suffix))
            staged.append(destination)
        with tempfile.TemporaryDirectory(prefix="basilisk-wpe-test-") as profile:
            import shutil
            extension = Path(profile, "extensions/content-bridge-test@basilisk-browser.org")
            shutil.copytree(Path(__file__).resolve().parent / "extension", extension)
            prefs = {
                "extensions.autoDisableScopes": 0,
                "extensions.enabledScopes": 15,
                "browser.shell.checkDefaultBrowser": False,
                "browser.startup.page": 0,
                "browser.dom.window.dump.enabled": True,
                "wpe.test.port": server.server_port,
                "wpe.test.mode": args.mode,
            }
            Path(profile, "user.js").write_text("\n".join(
                "user_pref(%s, %s);" % (json.dumps(key), json.dumps(value))
                for key, value in prefs.items()))
            process = subprocess.Popen([
                str(binary), "-no-remote", "-profile", profile, "-chrome",
                "chrome://browser/content/webkit/wpe-stress-test.xul",
            ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
            output = []
            watchdog = threading.Timer(600, process.kill)
            watchdog.start()
            try:
                for line in process.stdout:
                    print(line, end="", flush=True)
                    output.append(line)
                    if "WPE-STRESS KILL WebProcesses" in line:
                        # Kill only WPE WebProcesses in this test browser's descendant tree.
                        # Never select processes by a global name match.
                        import os, signal
                        parents, commands = {}, {}
                        for proc in Path("/proc").iterdir():
                            if not proc.name.isdecimal(): continue
                            try:
                                pid = int(proc.name)
                                parents[pid] = int((proc / "stat").read_text().rsplit(")", 1)[1].split()[1])
                                commands[pid] = (proc / "cmdline").read_bytes().split(b"\0")[0]
                            except (FileNotFoundError, PermissionError, ProcessLookupError): pass
                        owned = {process.pid}
                        while True:
                            more = {pid for pid, parent in parents.items() if parent in owned}
                            if more <= owned: break
                            owned |= more
                        victims = [pid for pid in owned if commands.get(pid, b"").endswith((b"WPEWebProcess", b"WebKitWebProcess"))]
                        if not victims: raise RuntimeError("No owned WPE WebProcess found")
                        for pid in victims:
                            try: os.kill(pid, signal.SIGKILL)
                            except ProcessLookupError: pass
                        print("Killed %d test-owned WebProcesses" % len(victims), flush=True)
                process.wait(timeout=30)
            finally:
                watchdog.cancel()
                if process.poll() is None: process.kill(); process.wait()
            text = "".join(output)
            return 0 if process.returncode == 0 and marker + " PASS all" in text and marker + " FAIL " not in text else 1
    finally:
        for path in staged:
            path.unlink()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
