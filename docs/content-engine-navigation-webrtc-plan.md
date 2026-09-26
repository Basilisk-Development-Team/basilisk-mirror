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
