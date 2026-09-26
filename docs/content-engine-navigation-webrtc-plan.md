# Navigation, WebRTC and functional extension follow-up

Preserve the generic content boundary, native Gecko services and upstream sources.

1. Reproduce actual URL-bar keyboard input, trace XBL `_loadURL` →
   `openUILinkIn`/`openLinkIn` → browser `loadURIWithFlags`. Fix input resolution
   in the generic adapter and guard the shared `_loadURIWithFlags` docshell path.
   Test bookmark/history/Home/search helpers, routing and a non-WPE mock.
2. Separate WebRTC API exposure, no-capture peer connections, capture denial and
   runtime plugin availability. Inspect actual CMake configuration and public
   permission source. Enable supported upstream build features without a patch.
3. Add truthful generic capabilities/diagnostics, retain denial whenever requester
   origins are absent, test local peer connections and lifecycle/private behavior.
4. Trace the installed, unmodified uBlock using deterministic server counters.
   Add portable script timing/frame/style/messaging and policy primitives only
   where supported. Never counterfeit Gecko windows/channels or patch uBlock.
5. Validate network blocking before fetch, repeat Gecko/alternate stress and
   extension/session tests, disabled build audit and hidden-checkout packaging.
   Report any necessary extension adaptation separately, without applying it.

## Initial evidence

Fully qualified URL-bar navigation worked in a fresh profile, including native
X11 keyboard input. Scheme-less input failed: the adapter discarded UXP fixup
flags and supplied unresolved input to a URI-only backend. Existing tests used
fully qualified URIs and missed this. The generic adapter now uses the existing
nsIURIFixup service before dispatch/routing; Gecko keeps its original path.

The installed WPE build had ENABLE_WEB_RTC=OFF and USE_GSTREAMER_WEBRTC=OFF,
with ENABLE_MEDIA_STREAM=ON. In a secure loopback page, mediaDevices/getUserMedia
were present but RTCPeerConnection was undefined. GStreamer 1.28.1 headers and
libraries existed, but its webrtcbin plugin and libgstwebrtcnice were absent.
That plugin requires libnice >=0.1.23; the host package supplies 0.1.22. These
are independent failures from the existing capture-origin permission blocker.

## Confirmed diagnostic boundaries

The original bundled CMake cache had `ENABLE_WEB_RTC=OFF` and
`USE_GSTREAMER_WEBRTC=OFF`, although `ENABLE_MEDIA_STREAM=ON`. Secure loopback
content exposed `navigator.mediaDevices.getUserMedia`, but
`typeof RTCPeerConnection` was `undefined`. An audio request reached the native
permission-denial path (`NotAllowedError`); video and combined requests reported
`OverconstrainedError` on this machine, whose WebKit device discovery reported
zero cameras. These are three separate findings.

The host has GStreamer 1.28.1 runtime/development libraries and libnice 0.1.22,
but no `webrtcbin` plugin or `libgstwebrtcnice`. GStreamer 1.28.1's WebRTC plugin
requires libnice >= 0.1.23. `tools/wpe/build-webrtc-plugins.py` builds pristine,
checksum-pinned upstream sources and stages only `webrtcbin`, its NICE adapter,
libnice 0.1.23 and the matching NICE plugin. It refuses a different system
GStreamer version. It does not install into `/usr` or copy the host plugin tree.

System requirements remain GStreamer core/base libraries plus the DTLS, SRTP,
SCTP and RTP plugins; Opus/VP8 and other codecs remain optional system plugins.
The generic WebRTC capability checks WebKit's enabled setting and the required
ICE/DTLS/SRTP/SCTP factories. It is independent of the media-capture capability.
Factory presence is a prerequisite, not a claim that external ICE networks or
every codec work. A local two-peer data-channel test and synthetic WebAudio RTP
test provide runtime evidence separately.

### Permission API: no secure identifiable subset

In upstream WPE 2.54.0,
`Source/WebKit/UIProcess/API/glib/WebKitUserMediaPermissionRequest.cpp`,
`webkitUserMediaPermissionRequestCreate` receives both requesting and top-level
`API::SecurityOrigin` objects and explicitly leaves storing them as a FIXME.
Its public API exposes audio/video/display-device flags, not those origins or a
trustworthy frame identity. Therefore even a request apparently originating in
the top-level page cannot be distinguished safely from an iframe request using
the public permission object. Top-level URL, timing, previous requests, frame
script messages and UI state are not substitutes.

The adapter continues to deny capture and emits a generic diagnostic denial
with null requester/top-level origin. It exposes the public capture-state
getters, never inferred state. There is no new grant UI or persistent grant.

The smallest upstream change is to retain the two origins already supplied to
the request constructor and expose read-only security-origin getters (including
opaque-origin representation and documented lifetime) on the public permission
request. That would benefit all WPE embedders implementing trustworthy permission
prompts. No upstream source change is made here. Core peer connections, data
channels and non-device synthetic media can operate independently of this API.

### Transport result after enabling the feature

The rebuilt engine exposes `RTCPeerConnection`; construction, data-channel
creation, offer/answer creation and setting both descriptions succeed. GStreamer
reports ICE gathering beginning, but zero candidates are emitted and local data
channels time out. The test intentionally remains failing for transport.
Gecko's identical local test delivers `echo:hello` before and after switching.

This is not a camera-permission failure. `/proc` namespace inspection shows the
WebProcess has its own network namespace with only `lo`; the NetworkProcess
shares the host network namespace. Upstream
`UIProcess/Launcher/glib/BubblewrapLauncher.cpp:shouldUnshareNetwork` isolates
WebProcess networking. With `USE_LIBRICE=OFF`,
`WebCore/Modules/mediastream/gstreamer/GStreamerMediaEndpoint.cpp` uses the
ordinary webrtcbin/libnice ICE agent in that isolated WebProcess. Its alternative
`USE_LIBRICE` path creates the upstream NetworkProcess-backed ICE agent.

The available sandbox-preserving upstream path requires librice's Rust-based
ICE dependencies, which are not installed. This task's no-Rust constraint is
preserved. No remote-inspector workaround, sandbox disabling, custom UXP IPC or
WebKit networking through Gecko is introduced. Providing a C/C++ libnice agent
through WebKit's existing NetworkProcess transport boundary would require
upstream implementation work, not a Basilisk chrome permission workaround.
Alternatively, use of upstream librice would require resolving the dependency
constraint separately. Capture-origin getters alone would not fix this transport
problem.

Adapter-owned `basilisk-build.ini`, generated from the actual CMake cache,
contains feature booleans only. `CAP_WEBRTC` is not advertised for the known
network-isolated libnice configuration even though the JavaScript API exists.
`CAP_MEDIA_CAPTURE` remains absent. A future broker-enabled build additionally
checks settings and required GStreamer factories before advertising transport.

Synthetic WebAudio successfully produces an audio track and negotiates Opus,
but there is no proven inbound RTP delivery in this configuration. Do not report
this as an end-to-end audio call. Audio-only capture is denied through the generic
permission diagnostic; camera requests on this host fail device constraints
before reaching that permission callback. Cross-origin microphone requests are
denied. Pending capture/script close and engine-switch handling, process failure
recovery, private-mode denial and shutdown are tested separately from transport.
