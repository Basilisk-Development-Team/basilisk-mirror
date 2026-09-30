#!/usr/bin/env python3
"""Local WPE media decode/render check; no public site required.

By default this tests WAV/VP8 against an uninstalled build. --runtime-prefix
also checks relocation; --h264 selects generated H.264 instead of VP8.
It does not establish audible-device output or AAC support.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import wave

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, default=root.parents[1] / 'build-wpe-deps/darwin-media-build')
parser.add_argument('--runtime-prefix', type=Path,
                    help='Stage an installed runtime and also test with checkout/MacPorts hidden')
parser.add_argument('--h264', action='store_true', help='Generate H.264 using AVFoundation')
parser.add_argument('--aac', action='store_true', help='Convert the PCM fixture to AAC using afconvert')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='wpe-media-') as directory:
    directory = Path(directory)
    shutil.copy2(root / 'darwin-media-smoke.html', directory / 'index.html')
    # Silent PCM avoids playing a tone on the user's desktop. Playback must
    # still create a decoder/output pipeline and advance its media clock.
    with wave.open(str(directory / 'tone.wav'), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(44100)
        audio.writeframes(bytes(3 * 44100 * 2))
    if args.aac:
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '128000',
            str(directory / 'tone.wav'), str(directory / 'tone.m4a')], check=True, timeout=30)
        page = directory / 'index.html'
        page.write_text(page.read_text().replace('tone.wav', 'tone.m4a'))
    if args.h264:
        generator = directory / 'make-video'
        subprocess.run(['clang', '-fobjc-arc', '-framework', 'AVFoundation', '-framework', 'CoreVideo',
            '-framework', 'CoreMedia', '-framework', 'Foundation',
            str(root.parent / 'contentengine/macos/make-video.m'), '-o', str(generator)], check=True)
        subprocess.run([str(generator), str(directory / 'red.mp4')], check=True, timeout=30)
        page = directory / 'index.html'
        page.write_text(page.read_text().replace('red.webm', 'red.mp4').replace(
            'const expectedRed = 255;', 'const expectedRed = 220;'))
    else:
        subprocess.run(['gst-launch-1.0', '-q', 'videotestsrc', 'num-buffers=90', 'pattern=red',
            '!', 'video/x-raw,width=160,height=90,framerate=30/1', '!', 'vp8enc', 'deadline=1',
            '!', 'webmmux', '!', 'filesink', 'location=' + str(directory / 'red.webm')],
            check=True, timeout=30)
    print('Testing ' + ('AAC' if args.aac else 'WAV') + ' audio and ' +
          ('H.264' if args.h264 else 'VP8') + ' video', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(directory)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        uri = 'http://127.0.0.1:%d/' % server.server_port
        if args.runtime_prefix:
            command = [sys.executable, str(root / 'check-darwin-runtime.py'),
                '--prefix', str(args.runtime_prefix), '--uri', uri]
        else:
            command = [sys.executable, str(root / 'run-darwin-webview-smoke.py'),
                '--build', str(args.build), uri]
        subprocess.run([*command, '--expect-title', 'PASS WPE media'], check=True, timeout=600)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
