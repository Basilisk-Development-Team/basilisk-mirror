# WPE Darwin downstream patches

This experimental series applies to the full upstream Git revision in
`upstream.json`, not the Linux release archive. That archive omits Darwin files.
The Linux pin and patch series remain unchanged.

From a clean checkout of the pinned revision, first apply the shared series in
`../patches/series`, then this directory's `patches/series`, using `git apply`
in listed order. The shared series belongs to upstream Basilisk's webkit branch;
this port does not replace it. Do not apply either series twice. Build products
belong outside the source checkout.

The Darwin-only series contains 28 patches. The earlier related-view API patch
0026 and compiled-block notification patch 0030 are deliberately not carried
forward: they belong to discarded feature work, not the macOS port. Numbering
of the remaining patches is retained for traceability. Historical test results
below describe the original port; the upstream refresh is validated separately.

## 0001 — Cocoa-port WebKitLegacy dependency

* File: `Source/WebKit/CMakeLists.txt`.
* Problem: `APPLE` selects WebKitLegacy linkage and re-export even for PORT=WPE,
  which does not build a WebKitLegacy target. CMake generation fails.
* Change: restrict those two selections to PORT=Mac/IOS. Retain the existing
  Apple Objective-C weak-reference compiler flag.
* API added: none. Linux WPE and Cocoa Mac/IOS selections are unchanged.
* Validation: pinned full-source PORT=WPE arm64 Darwin CMake generation passes.
  Foundation compilation is separate; generation is not runtime validation.
* Upstreamability: a generic host-OS versus selected-port build correction.

No application or addon identities belong in this series.

## 0002 — WPE Darwin foundation selection

* File: `Source/WTF/wtf/PlatformWPE.cmake`.
* Problem: Darwin signal handling needs generated Mach exception stubs; the WPE
  source list unconditionally selects Linux scheduling and memory sources.
* Change: reuse the existing JSCOnly Darwin Mach generation, Mach memory
  footprint and generic memory-pressure implementation. Keep WPE's GLib run loop
  and timezone support. Non-Apple source selections stay unchanged.
* API added: none. Automatic native memory-pressure notification is not provided
  by the generic handler and remains a port milestone, not a completed feature.
* Validation: generated Mach stubs and selected foundation sources compile on
  arm64 with the public macOS 15.5 SDK. Final linkage/runtime are separate checks.
* Upstreamability: contained WPE platform source selection using existing code.

Verify tracked source contents and patch inventory without changing the checkout:

```
python3 tools/wpe/verify-darwin-source.py
```

## 0003 — WPE Darwin ANGLE backend

* File: `Source/ThirdParty/ANGLE/PlatformWPE.cmake`.
* Problem: WPE unconditionally defines ANGLE_PLATFORM_LINUX and selects Linux
  sources, failing on linux/futex.h even on Darwin.
* Change: select the existing upstream Mac/Metal backend on Apple, build EGL/GLES
  as dylibs for the WPE dispatcher. Other platforms retain existing selections.
* API added: none. Metal context/render/readback validation passes with patch
  0007; WPE page presentation remains outstanding.

## 0004 — EGL platform-display argument

* File: `Source/WebKit/WPEPlatform/wpe/headless/WPEDisplayHeadless.cpp`.
* Problem: eglGetPlatformDisplay takes a void pointer, but EGL_DEFAULT_DISPLAY
  expands to an integer EGLNativeDisplayType on Darwin.
* Change: use nullptr for the surfaceless default platform display in both EGL
  entry points. Linux receives the same null pointer as before.
* Validation: all WPEPlatform objects compile on Darwin with the private EGL
  dependency. This object target does not establish final linkage or rendering.

## 0005 — WPE library/header layout on Darwin

* Files: `Source/cmake/WebKitFS.cmake`, `Source/cmake/WebKitMacros.cmake`.
* Problem: host-Apple framework layout conflicts with WPE's monolithic/object
  library selection; LLIntSettingsExtractor resolves system JavaScriptCore
  headers rather than the generated pinned-source headers.
* Change: keep WPE's non-framework library/header layout on Darwin. Other ports
  retain their existing layout. No API is added.
* Validation: full JavaScriptCore compilation continues separately; do not infer
  a JIT/runtime pass from generated headers.

## 0006 — Explicit WPE PAL dependencies

* File: `Source/WebCore/PAL/pal/PlatformWPE.cmake`.
* Problem: PAL compiles gcrypt/tasn1 consumers without declaring their imported
  targets. A private-prefix gcrypt.h is not on the compiler include path.
* Change: declare LibGcrypt::LibGcrypt and Tasn1::Tasn1 alongside GLib::GLib.
  This expresses actual existing source dependencies; no API or runtime policy
  is changed. It also benefits non-Darwin builds with non-system prefixes.
* Validation: continue the full WPE build with dependencies in the private prefix.

## 0007 — Shared ANGLE entry points

* File: `Source/ThirdParty/ANGLE/PlatformWPE.cmake`.
* Problem: Cocoa's static-library setup leaves generated public EGL/GLES C entry
  points hidden when the libraries become shared; a real consumer cannot link.
* Change: default visibility for the two generated public entry-point source
  files on WPE Darwin, keeping other implementation sources hidden.
* Validation: actual ANGLE/Metal EGL 1.5 context, pbuffer render/readback and
  teardown pass on Apple M3 Pro/macOS 15.7.1, directly and through libepoxy.
  Readback is RGBA 51,102,153,255. This is not a WebKit page render test.

## 0008 — Darwin WPE key backend selection

* Files: `Source/WebCore/crypto/keys/CryptoKeyEC.{h,cpp}`, `CryptoKeyRSA.h`.
* Problem: host-Darwin guards select Cocoa key representations alongside WPE's
  existing gcrypt representation and require unselected Cocoa PAL headers.
* Change: exclude WPE alongside the existing GTK exclusion. The selected WPE
  implementation remains unchanged; no new key/API semantics are introduced.
* Validation: the affected binding source compiles in the ongoing engine build.

## 0009 — Optional-media binding guard

* File: `Source/WebCore/bindings/js/JSHTMLMediaElementCustom.cpp`.
* Problem: it references an absent generated JSHTMLMediaElement class when video
  is disabled. This is also reproducible for other no-video configurations.
* Change: guard the translation unit after config.h with ENABLE(VIDEO), matching
  the feature's generated class availability. Video-enabled code is unchanged.
* Validation: the no-media unified binding source compiles. This does not
  implement media support in the port.

## 0010 — External ICU for WPE Darwin

* Files: `Source/cmake/FindICU.cmake`, `Source/WTF/CMakeLists.txt`.
* Problem: the Cocoa host selection combines versioned upstream ICU headers
  with system icucore, leaving unresolved versioned symbols at final linkage.
* Change: WPE uses the existing external ICU discovery path on Darwin and does
  not copy Cocoa-port ICU headers into the external dependency's include path.
  Other ports retain their existing selections.
* Validation: configure and foundation linkage pass with MacPorts ICU 78.3.
  No system dependency files are modified. Full engine execution is pending.
* API added: none. Upstreamability: contained port dependency selection.

## 0011 — Darwin allocator process checks

* File added: `Source/bmalloc/PlatformWPE.cmake`.
* Problem: Darwin allocator code references process-check functions absent from
  the WPE source list, causing unresolved symbols during foundation linkage.
* Change: select the existing `ProcessCheck.mm` implementation and Foundation
  dependency on Apple hosts, as the JSCOnly port does. No allocator policy or
  non-Apple source selection changes.
* Validation: foundation linkage and 1,000 WPEPlatform display/SHM-buffer
  creation/destruction cycles pass with the active build objects.
* API added: none. Upstreamability: contained platform source selection.

## 0012 — Generic scrollbar allocator annotation

* Files: `Source/WebCore/platform/generic/ScrollbarsControllerGeneric.{h,cpp}`.
* Problem: the derived generic controller uses fast allocation despite its
  base class requiring TZone allocation. TZone-enabled Darwin compilation
  correctly rejects the inconsistent declaration.
* Change: use the same TZone declaration/implementation pair as the native
  controller. No scrollbar behavior changes or assertion removal.
* API added: none. Upstreamability: generic allocator annotation correction.
* Validation: affected unified source rebuilt in the full WPE configuration.

## 0013 — EGL native-display pointer types

* Files: `Source/WebCore/platform/graphics/egl/PlatformDisplaySurfaceless.cpp`,
  `Source/WebCore/platform/graphics/angle/PlatformDisplayANGLE.cpp`.
* Problem: Darwin's integer `EGL_DEFAULT_DISPLAY` cannot initialize the pointer
  arguments required by platform-display APIs or the stored native pointer.
* Change: use null pointers directly, including the already-null stored value.
  This preserves the prior value on Linux. No display backend is selected by
  this patch; ANGLE/Metal display selection in WebCore remains runtime work.
* Validation: affected WebCore units compile. No public API changes.

## 0014 — Unix-transport semaphores on Darwin

* Files: `Source/WebKit/Platform/IPC/IPCSemaphore.h`,
  `Source/WebKit/Platform/IPC/unix/IPCSemaphoreUnix.cpp`,
  `Tools/TestWebKitAPI/Tests/IPC/EventTests.cpp`.
* Problem: the Unix implementation only implements Linux eventfd; Darwin
  construction otherwise leaves an invalid descriptor and waits always fail.
* Change: Darwin uses an atomically counted shared-memory object and public
  `os_sync_wait_on_address`/`os_sync_wake_by_address_any` in shared mode. The
  existing single-descriptor IPC format is retained. Mappings outlive their
  creator through independent descriptor ownership. Waits recheck the counter
  after interruption/wakeup and retain the original deadline. Linux and Cocoa
  Mach implementations are unchanged.
* Minimum: macOS 14.4 for this optional WPE implementation; lower deployment
  targets fail explicitly. This does not change any Basilisk/Gecko target.
* Public WPE API added: none; this repairs the internal IPC primitive.
* Validation: the actual patched semaphore and SharedMemory sources pass a
  standalone consumer test: 100,000 queued tokens, timeout, moved/duplicated
  ownership and 20,000 round trips to a freshly spawned process with descriptors
  passed through SCM_RIGHTS. The smaller API probe also verified different
  virtual addresses for the same shared mapping. Whole WebProcess operation is
  not yet validated. Added TestWebKitAPI cases are not yet run in that harness.
* Command: `python3 tools/wpe/run-darwin-platform-smoke.py --ipc`.
* Upstreamability: a generally useful Darwin Unix-transport implementation using
  public OS primitives, without embedding-application dependencies.

## 0015 — Respect Unix IPC transport on Darwin

* Files: `Source/WebKit/Platform/IPC/{Attachment.h,Connection.h,Connection.cpp,
  ConnectionHandle.serialization.in}`, `Source/WebKit/Shared/
  WebCoreArgumentCoders.serialization.in`, `Source/WebKit/NetworkProcess/
  NetworkProcess.cpp`.
* Problem: host-Darwin guards select Mach attachments/XPC members despite the
  selected Unix socket transport. Generated serializers also declare both Unix
  and Mach handles for the same member. Compilation fails before process launch.
* Change: keep Mach-specific members, serializers and PID diagnostics exclusive
  to the Mach transport. WPE Darwin follows the existing Unix path; ordinary
  Cocoa and Linux behavior are unchanged. No new IPC wire representation.
* Validation: generated serializers and NetworkProcess units compile; full
  process/link/runtime validation is ongoing. No public API is added.

## 0016 — WPE C event API selection

* Files: `Source/WebKit/UIProcess/API/C/{WKNativeEvent.h,WKPagePrivate.h}`.
* Problem: host-Apple tests choose NSEvent types and omit non-Cocoa completion
  declarations, despite WPE's implementation using its existing opaque events.
* Change: honor the existing BUILDING_WPE__/BUILDING_GTK__ selection alongside
  the host OS. No event conversion or Cocoa object emulation is introduced.
* Validation: the previously failing WKPage.cpp compiles. API semantics for
  existing Cocoa/Linux builds are unchanged.

## 0017 — WebProcess ANGLE Metal display

* Files: `Source/WebCore/platform/graphics/egl/PlatformDisplaySurfaceless.cpp`,
  `Source/WebCore/platform/graphics/angle/PlatformDisplayANGLE.cpp`.
* Problem: the GLib WebProcess requires a Mesa surfaceless platform that the
  actual Darwin ANGLE library does not advertise. With no supported fallback,
  display initialization would abort.
* Change: select the advertised ANGLE Metal platform on WPE Darwin. Reuse the
  native ANGLE display/context for WebGL, as the Windows implementation does,
  instead of nesting an OpenGL ES ANGLE display around a Metal display.
* Validation: actual EGL client extensions and Metal pbuffer rendering were
  checked; modified WebCore units compile. WebProcess runtime remains pending.
  Linux display selection is unchanged. No public API added.

## 0018 — Optional DRM snapshot handling

* File: `Source/WebKit/UIProcess/wpe/AcceleratedBackingStore.cpp`.
* Problem: snapshot code references a DRM format constant when DRM headers and
  support are disabled, breaking the SHM-only build.
* Change: guard only the DMA-buffer format branch by the same conditions used
  for its headers. SHM snapshots remain available without DRM.
* Validation: affected backing-store source compiles. No API added and no
  changes to DRM-enabled behavior.

## 0019 — Missing TZone definitions

* Files: `Source/WTF/wtf/glib/RunLoopGLib.cpp`,
  `Source/WebCore/page/scrolling/coordinated/ScrollerCoordinated.cpp`,
  `Source/WebCore/platform/graphics/skia/ImageBufferSkiaAcceleratedBackend.cpp`.
* Problem: link failures for ActivityObserver, ScrollerCoordinated and
  SkiaSwitchableCanvas allocator symbols. The scroller file accidentally
  defines ScrollerPairCoordinated, already defined by its own translation unit.
* Change: supply the declared classes' implementation macros, retaining their
  existing allocator choices. No assertion or allocator policy is disabled.
* Validation: affected units compile; full-library relink is in progress.
  This is a generic definition correction, not a public API change.

## 0020 — Required Skia sources

* File: `Source/ThirdParty/skia/CMakeLists.txt`.
* Problem: final linkage cannot resolve SkStrikeRef's constructor or SkPath's
  dump method. Both existing implementations are absent from the source list.
* Change: include `src/core/SkStrikeRef.cpp` and `src/core/SkPathDump.cpp`.
* Validation: both compile with the pinned Skia configuration. Final relink is
  in progress. No Skia implementation or public API is modified.

## 0021 — Link dependencies and receiver selection

* Files: `Source/WebCore/PlatformWPE.cmake`, `Source/WebKit/PlatformWPE.cmake`.
* Problem: Darwin-selected vImage operations and gettext calls lack Accelerate
  and Intl linkage. WPE also generates gesture message receivers for controller
  implementations it does not select, producing unresolved handler symbols.
* Change: declare Accelerate/Intl on Apple; omit the two unsupported gesture
  receivers from WPE's message-generation list. This does not remove the WPE
  platform input/scroll path or add dummy gesture handlers.
* Validation: CMake generation passes; the full library is being relinked.
  Existing GTK/Cocoa port selections remain unchanged. No public API added.

## 0022 — Generic key data on Darwin WPE

* File: `Source/WebCore/crypto/CryptoKey.cpp`.
* Problem: host-Darwin excludes the generic random-data implementation although
  the WPE backend does not select the Cocoa implementation, leaving an undefined
  method at final linkage.
* Change: include WPE alongside GTK in the existing generic implementation's
  guard. The selected platform random provider is unchanged.
* Validation: the unit compiles; full-library relink remains in progress.
  No public API or algorithm is added.

## 0023 — GLib Unix stream IPC on Darwin

* Files: `ProcessLauncherGLib.cpp`, `ConnectionGLib.cpp`, `UnixMessage.h`.
* Problem: Darwin rejects AF_UNIX/SOCK_SEQPACKET in the launcher, before the
  NetworkProcess starts. GLib's connection decoder also assumed one complete
  message per receive call. Datagram fallback would lose reliable peer-close
  semantics, so this port uses stream sockets.
* Change: select SOCK_STREAM only on Darwin; receive exactly one header/body
  boundary while retaining partial bytes/descriptors across EAGAIN. Track partial
  output progress in the pending message, transfer descriptors once, and resume
  from the writable notification. The wire format and other platforms' socket
  selection stay unchanged. Truncated descriptor errors now carry a GError.
* API added: none. This is a transport portability change below the embedding API.
* Tests: actual GLib reader fixture covers fragmented headers, EAGAIN, coalesced
  messages, descriptor transfer/CLOEXEC, EOF and invalid frame lengths:
  `python3 tools/wpe/run-darwin-platform-smoke.py --stream`.
  Full WPE helpers load/render a local HTML document with exact AppKit pixel
  readback and load/render https://example.com with title/URI callbacks. Helpers
  terminate after the fixture exits. Full IPC test-suite and partial-send stress
  coverage remain outstanding; these passes do not establish browser stability.
* Upstreamability: useful to GLib embedders on Unix hosts without sequenced-packet
  sockets. No application or extension concepts enter the transport.

## 0024 — WebDriver without logging channels

* File: `Source/WebDriver/WebDriverService.cpp`.
* Problem: request handling references a log channel even when both logging
  facilities are disabled and Logging.h deliberately declares no channels.
* Change: guard the optional timing/logging wrapper with the same feature
  condition as its channel declarations. Request handling itself is unchanged.
* API added: none. Applicable to any no-logging WebDriver configuration.
* Validation: full SDK build compiles the enabled WebDriver target separately
  from the already validated WPE library/helpers. Full build and WebDriver
  linkage pass on arm64 Darwin.

## 0025 — Install Darwin ANGLE runtime libraries

* File: `Source/ThirdParty/ANGLE/CMakeLists.txt`.
* Problem: WPE Darwin uses shared EGL/GLES libraries, but the upstream Cocoa
  static-library setup supplies no install rules. An installed WPE SDK lacks
  its graphics runtime dependencies.
* Change: install the selected EGL/GLES shared targets only for WPE on Darwin.
  No other port or public API changes.
* Validation: installed SDK and relocation checks are performed separately from
  the successful build-tree Metal/render tests.

## 0027 — Optional GStreamer video dependencies

Identical to common patch 0002 documented in `../README.md`. The separate media
configuration succeeds using installed GStreamer 1.28.7 after honoring the
existing OFF flags for optional GL/MPEG-TS components. No public API is added;
the no-media runtime remains independently buildable. Playback/build validation
is separate from configuration success.

## 0028 — GStreamer fixed-width output parameters

* Baseline: pinned `wpewebkit-2.54.0` revision above, after patches 0001–0027.
* Files: `Source/WebCore/platform/graphics/gstreamer/GStreamerCommon.cpp` and
  `MediaPlayerPrivateGStreamer.cpp`, plus `mse/WebKitMediaSourceGStreamer.cpp`.
* On Darwin, the system's `int64_t`/`uint64_t` and installed GLib's
  `gint64`/`guint64` have different C++ types despite equal widths. Six media
  API calls fail compilation when standard integer pointers are passed to
  GStreamer output parameters.
* Use GStreamer's declared output types at those call sites, converting values
  at the existing WebCore return boundary. No casts between pointer types,
  new API, behavior change or embedder-specific code.
* Suitable for upstream independent of the Darwin port. Existing upstream
  `GStreamerTest.gstStructureGetters` covers the conversion values; the Darwin
  media build exercises all corrected call sites. Runtime playback/seek tests
  are tracked separately and must not be inferred from compilation.

## 0029 — Media TZone allocation definitions

* File: `Source/WebKit/UIProcess/Media/RemoteMediaSessionManagerProxy.cpp`.
* Baseline: the pinned revision above with the preceding patch series.
* The Cocoa-only listener's TZone allocation implementation was outside the
  Cocoa guard even though its class definition was inside. WPE on Darwin uses
  TZone allocation but not `PLATFORM(COCOA)`, exposing the incomplete type.
* Put the allocation implementation under the same existing guard. No new API,
  allocator change or behavior change for ports defining the class. This is an
  independent upstreamable build fix, exercised by the media-enabled WPE build.

* The same enabled-media link also exposes missing TZone definitions for
  `TrackDataHolder` and `WebKitVideoSinkProbeOwner`. Add their standard allocation
  definitions to `TrackPrivateBaseGStreamer.cpp` and
  `GStreamerVideoSinkCommon.cpp`, with explicit allocation-inline includes.
  These classes already declare TZone allocation; this supplies their missing
  implementations rather than changing allocation policy. The full media link
  is the regression check; Linux configurations with TZone disabled hid these
  omissions.
