# Navigation, WebRTC and extension validation — 2026-09-26

LoongArch64, WPE 2.54.0, JSC CLoop, JIT/DFG/FTL disabled. Gecko remains the default.
No UXP or bundled upstream WebKit/WPE source was edited. The pre-existing
`platform` submodule-pointer difference was left alone. The user's running normal
browser/profile was not used by the fixtures.

## Navigation

Root cause: the generic alternate-view adapter discarded URI-fixup flags and
passed unresolved chrome input to the native URI-only loader. Fully qualified
URIs worked; scheme-less address-bar input reproduced the failure. The actual
path is URL-bar XBL `_loadURL`, `openUILinkIn`/`openLinkIn`, then the selected
browser's `loadURIWithFlags`. The shared `_loadURIWithFlags` helper also had a
bookkeeping-docshell dispatch that needed the same generic boundary.

The adapter now resolves input with UXP's `nsIURIFixup` service and appropriate
fixup flags, then applies existing engine routing/manual precedence. Gecko keeps
its original load path. New chrome navigation invalidates queued route/deferred
load tokens; stale callbacks cannot send the next navigation to a hidden view.
The editing controller respects chrome focus so Paste & Go does not target the
foreign page clipboard. No WPE check was added to the address bar.

Native keyboard tests cover typed HTTP/HTTPS, scheme-less URLs, GET search,
pasted URL+Enter, Paste & Go, bookmark/history commands, Home, back/forward,
reload, current/new tab, new window and chrome-link helpers in both engines.
Mock-backend tests cover the generic address-bar path. Routing tests cover
Gecko→Gecko, Gecko→WebKit, WebKit→WebKit and WebKit→Gecko, with manual override
above exact host/origin rules above default, redirect/subframe isolation and
superseded route cancellation. POST search submission remains explicitly
unsupported in alternate views; it is not silently converted to GET.

## WebRTC: separate results

| Layer | Result |
| --- | --- |
| Original build | `ENABLE_WEB_RTC=OFF`, `USE_GSTREAMER_WEBRTC=OFF`; mediaDevices existed but RTCPeerConnection did not |
| Rebuilt feature state | Both RTC flags ON, media stream ON, bubblewrap sandbox ON, USE_LIBRICE OFF |
| JavaScript availability | mediaDevices, getUserMedia and RTCPeerConnection present on secure loopback/HTTPS |
| Peer setup | Construction, data channel, offer/answer, local/remote descriptions pass |
| ICE/data transport | Gathering begins, zero candidates, local data-channel timeout; **not working** |
| Synthetic media | WebAudio track and Opus SDP negotiation work; no proven inbound RTP |
| Audio capture | NotAllowedError, explicit generic origin-unavailable denial |
| Video / combined capture | OverconstrainedError on this host, which reports no cameras |
| Cross-origin/private microphone | Denied; no origin substitution or grants |
| Public diagnostic | Upstream WebRTC datachannel sample loads; start begins negotiation, send remains disabled |
| Gecko control | Same local peer exchange returns `echo:hello`, including disabled build and after engine switches |
| Capabilities | WEBRTC false for known sandbox-isolated libnice build; MEDIA_CAPTURE false |

There are two independent upstream/constraint boundaries, detailed in the
[diagnostic plan](content-engine-navigation-webrtc-plan.md):

1. The network-isolated WebProcess's ordinary libnice agent cannot establish ICE
   in this build. Upstream's NetworkProcess-backed path uses Rust-based librice,
   excluded by the task's dependency constraint. A C/C++ equivalent needs upstream
   work. Disabling the sandbox, enabling remote Inspector to change its isolation,
   or routing through Gecko is not an acceptable fix.
2. Public WPE media-permission objects discard requesting/top-level origins that
   their constructor receives internally. No safe same-origin subset can be
   identified from the exposed device flags. Retaining and exposing those origins
   is the smallest general upstream API improvement; all ambiguous requests remain
   denied. Fixing this alone would not fix ICE transport.

The focused suite intentionally returns failure for missing WebKit peer transport.
It continues to record lifecycle/denial evidence rather than stopping at the first
transport failure. No test was marked expected-failure to produce a green result.

## Generic extension work

The new document-phase, frame-addressed execution/messaging, all-frame CSS and
expanded declarative request policy are described in the [shim contract](content-engine-shim.md).
Server counters verify actual pre-fetch blocking for script/image/stylesheet/
iframe/XHR/fetch/WebSocket/redirect targets, with allowed controls and toggle tests.
The same test confirms foreign rules do not alter Gecko policy. A discovered
upstream resource-method mismatch prevents exposing a misleading method filter.

The [unmodified uBlock audit](content-engine-ublock-audit.md) distinguishes working
chrome UI/storage/tab state from absent Gecko content/network hooks on alternate
content. No extension patch was applied. uBlock itself still does **not** block
WebKit requests or inject its cosmetics/picker, even though independent generic
fixtures can perform those operations. The audit proposes a portable extension
adapter and lists network attribution/logger/header limitations separately.

## Regression/stress results

| Test | Result |
| --- | --- |
| Enabled full build and disabled full build | Pass |
| Generic boundary scan | Pass; no WPE types/platform switches above adapter |
| Disabled audit | Pass, 30 development / 22 packaged ELF files, no WebKit component/interface/resource/link dependency |
| Copied enabled dist/bin relocation | Pass, 40 ELF files resolve without LD_LIBRARY_PATH |
| Extracted enabled installer relocation | Pass, 32 ELF files; checkout hidden, app-local helpers/resources, HTTPS/scripts/Inspector |
| Address-bar/chrome navigation suite | Pass both engines and disabled Gecko build |
| Mock chrome navigation | Pass |
| 100 Gecko→WebKit→Gecko cycles with address-bar loads | Pass; more than 50 WPE chrome navigations |
| 100 native attach/destroy cycles | Pass |
| 100 Gecko→WebKit→Gecko cycles with script/CSS + XUL fixture | Pass |
| 100 WebKit→Gecko→WebKit filtered cycles | Pass; no duplicate script registrations |
| 20 filtered cross-window adoptions | Pass |
| 20 simultaneous WPE tabs plus Gecko | Pass |
| Inspector open/close, WebProcess kill with Inspector, recovery | Pass |
| Pending script/capture teardown and engine switching | Safe rejection/denial; pass |
| 20-tab active-navigation shutdown, Inspector open | Pass |
| Persistence, private separation, mixed session restore | Pass |
| Extension fixtures A–F and routing suite | Pass |
| Both-engine frame/timing/CSP/stale-ID/messaging tests | Pass |
| Generic pre-fetch request counter matrix | Pass |
| Unmodified uBlock Gecko network/cosmetic control | Pass; alternate hooks remain incompatible |
| WebKit local peer transport, repeated/private/recovery | Fail, diagnosed boundary above |
| Gecko disabled peer smoke and shutdown | Pass after document cleanup |
| Upstream archive comparison | 38,842 files compared, zero changes |

The initial disabled Gecko-only diagnostic printed a successful peer exchange but
hung when its temporary sandbox/window was torn down immediately; its watchdog
killed the test browser. The fixture now navigates away and allows asynchronous
peer/document cleanup before closing the window. The final run exits normally.
No Gecko implementation or existing test was changed to hide that observation.

After completed stress runs no test-owned WebKit helper processes remained.
No crash occurred except deliberate WebProcess kills. These runs are functional
lifecycle checks, not a quantified memory-leak proof; no sanitizer was run.

## Reproduction

Run fixture commands after builds complete, with an available X11 display and
isolated profiles supplied by the runners. Do not build while a runner temporarily
stages chrome resources in the same object directory.

```sh
DISPLAY=:91 python3 tools/contentengine/navigation/run.py --help
DISPLAY=:91 python3 tools/contentengine/run-content-tests.py obj-webkit-enabled frames
DISPLAY=:91 python3 tools/contentengine/run-content-tests.py obj-webkit-enabled network
DISPLAY=:91 python3 tools/contentengine/run-content-tests.py obj-webkit-enabled webrtc --cycles 3 --external
DISPLAY=:91 python3 tools/contentengine/run-content-tests.py obj-webkit-disabled webrtc
DISPLAY=:92 python3 tools/wpe/run-lifecycle.py obj-webkit-enabled --cycles 100
DISPLAY=:92 python3 tools/contentengine/filters/run.py obj-webkit-enabled --cycles 100
DISPLAY=:93 python3 tools/wpe/run-stress.py obj-webkit-enabled --mode switching
DISPLAY=:93 python3 tools/wpe/run-stress.py obj-webkit-enabled --mode lifecycle
DISPLAY=:93 python3 tools/wpe/run-stress.py obj-webkit-enabled --mode shutdown
DISPLAY=:91 python3 tools/wpe/run-persistence.py obj-webkit-enabled
python3 tools/contentengine/check-boundary.py
python3 tools/wpe/check-disabled.py obj-webkit-disabled
```

The WebRTC command is expected to **report actual transport failure**, not pass,
with the current sandbox/libnice build. The optional public-page probe uses network
access; core peer tests and request-counter tests are entirely local.


## Final packages

Both `make package` runs completed. The resulting archives are:

* Enabled: `obj-webkit-enabled/dist/basilisk-20260926212217.linux-loongarch64-gtk3.tar.xz`
* Disabled: `obj-webkit-disabled/dist/basilisk-20260926210240.linux-loongarch64-gtk3.tar.xz`

Neither contains staged test chrome. The enabled archive was extracted, copied
again by `check-runtime.py --packaged`, audited with no loader environment and
launched with the entire checkout hidden. All 32 shipped ELF files resolved;
helpers/resources stayed application-local. HTTP/HTTPS, Gecko, isolated scripts,
CSS/messages and upstream Inspector passed. RTC API/SDP worked there too; ICE
transport remained unavailable and was reported explicitly. The disabled archive
passed component/interface/resource checks and all 22 shipped ELF dependency
checks without any WPE linkage. Ordinary system media/graphics dependencies
remain required as described in [runtime packaging](wpe-runtime-packaging.md).

Key local evidence logs are `/tmp/basilisk-navigation-stress100.log`,
`/tmp/basilisk-navigation-filter100.log`, `/tmp/basilisk-navigation-script100.log`,
`/tmp/basilisk-navigation-native100.log`, `/tmp/basilisk-webrtc-final-tests.log`,
`/tmp/basilisk-gecko-webrtc-disabled-final.log`, `/tmp/basilisk-ublock-final.log`,
`/tmp/basilisk-navigation-packaged-runtime.log` and
`/tmp/basilisk-navigation-disabled-package-audit.log`. These generated artifacts
are not committed. The committed fixtures reproduce the checks.
