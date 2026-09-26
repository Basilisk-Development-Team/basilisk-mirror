#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Run the XUL component lifecycle test in an unpackaged enabled build.

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
    parser.add_argument("--mixed", action="store_true", help="test real mixed browser tabs and engine switching")
    parser.add_argument("--cycles", type=int, default=10)
    args = parser.parse_args()
    if args.cycles < 1: parser.error("cycles must be positive")
    objdir = args.objdir.resolve()
    binary = objdir / "dist/bin/basilisk"
    chrome = objdir / "dist/bin/browser/chrome/browser/content/browser/contentengine"
    if not binary.is_file() or not (chrome / "prototype.xul").is_file():
        parser.error("requires a completed, unpackaged --enable-webkit build")
    name = "mixed" if args.mixed else "lifecycle"
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
        if args.mixed:
            destination = chrome / "wpe-mixed-operations.js"
            destination.symlink_to(fixture / "operations.js")
            staged.append(destination)
        with tempfile.TemporaryDirectory(prefix="basilisk-wpe-test-") as profile:
            prefs = {
                "browser.shell.checkDefaultBrowser": False,
                "browser.startup.page": 0,
                "browser.dom.window.dump.enabled": True,
                "wpe.test.port": server.server_port,
                "wpe.test.cycles": args.cycles,
            }
            Path(profile, "user.js").write_text("\n".join(
                "user_pref(%s, %s);" % (json.dumps(key), json.dumps(value))
                for key, value in prefs.items()))
            result = subprocess.run([
                str(binary), "-no-remote", "-profile", profile, "-chrome",
                "chrome://browser/content/contentengine/wpe-" + name + "-test.xul",
            ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=max(210, args.cycles * 15))
            print(result.stdout, end="")
            return 0 if (result.returncode == 0 and
                         marker + " PASS " in result.stdout and
                         marker + " FAIL " not in result.stdout) else 1
    finally:
        for path in staged:
            path.unlink()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
