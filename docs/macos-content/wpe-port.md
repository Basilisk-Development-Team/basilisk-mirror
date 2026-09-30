# WPE macOS port on refreshed upstream Basilisk

This branch starts at upstream `origin/webkit` revision
`7819d3d66011a9385c78b2a4539d370f4b9d13bd`. Only the macOS WPE port
is carried forward from the previous local development branch.

## Scope

Retained: Darwin WebKit build/IPC/graphics/media portability patches, native
Cocoa presentation of WPE surfaces, GLib main-runloop integration, native input,
clipboard and file chooser support, native Inspector hosting, optional build
selection, runtime packaging and port diagnostics.

Not retained: the WKWebView backend, local addon adapters, local compiled-policy
cache changes, block-notification/logger feature, shared browser feature changes,
or the previous daily-driver/stress documentation. Upstream's browser chrome,
addon compatibility code, request-policy implementation, storage services and
six shared WebKit patches remain authoritative. The Darwin host retains
upstream's user-context-specific window sessions rather than flattening them
into one session.

The old state is recoverable at
`backup/webkit-before-upstream-port-20260930`. Pre-existing uncommitted Linux
build-script edits were saved in the stash named
`Backup pre-port-rebase Linux script edits 20260930`, not reapplied. The existing
UXP checkout/gitlink mismatch was not changed or committed.

## Source and build

The release archive omits Darwin sources. Use the full upstream revision pinned
in `third_party/webkit/darwin/upstream.json`. Apply, in order:

1. `third_party/webkit/patches/series` (upstream Basilisk's six patches).
2. `third_party/webkit/darwin/patches/series` (28 port patches).

Run `python3 tools/wpe/verify-darwin-source.py` to verify the exact combination.
Earlier Darwin patches 0026 and 0030 are intentionally omitted because they
implemented separate feature work. Their remaining siblings keep their original
numbers for traceability.

Use `tools/wpe/configure-darwin.py` to configure the separate WPE SDK, followed
by `cmake --build` and `cmake --install`. Its default configuration is the
no-media bring-up variant; media-enabled builds use the documented optional
GStreamer configuration and bounded runtime supplements. The patch/dependency
notes are in `third_party/webkit/darwin/README.md`.

For Basilisk, select `--enable-webkit --with-wpe-runtime=<installed-Darwin-SDK>`.
Supply the SDK/dependency pkg-config paths. Darwin deliberately requires an
explicit SDK; upstream's automatic source-build path remains unchanged on Linux.
The macOS application embeds WPE through the existing generic content interface,
not WKWebView. `--disable-webkit` does not detect or link WPE.

The packaging step copies required runtime files into the application, rewrites
Mach-O lookup paths, and refreshes local execution signatures. No SDK/build path
is intended to be required at runtime. The existing generic test runner now
supports copied macOS application bundles and owned WPE helper termination,
while retaining upstream's fixture suites and Linux paths.

## Refresh validation

Results for the previous branch are not results for this refreshed combination.
Current checks:

- Exact source composition: pinned WebKit + six upstream patches + 28 Darwin
  patches passes verification.
- Enabled Basilisk configure passes with an explicit Darwin SDK.
- Native Cocoa host smoke passes three create/load/input/close cycles, including
  independent keyed window sessions, composition and clipboard. This initial
  smoke used the existing runtime while the combined SDK rebuild was running.
- Combined SDK build/install passes. Native host/Inspector and content-bridge
  checks pass with the rebuilt library. The standalone content-bridge fixture
  does not provide the full privileged legacy host and logs that missing reply;
  it is not an addon compatibility acceptance test.
- Relocated WPE loads HTTPS with the checkout and dependency prefix unavailable.
- Enabled and disabled Basilisk builds pass. Packaging passes; all 127 packaged
  Mach-O images pass the dependency/signature audit. Discarded local adapters
  and module resources are absent from the package's optimized archives.
- Disabled upstream UI/engine smoke passes, including a true WebKit preference
  with no compiled backend. The disabled dependency audit passes 35 images.
- Packaged enabled upstream smoke passes startup toggling, UI, routing, restore,
  native guard and existing-tab lifetime. Container tests pass both engine
  directions, same-container sharing, inter-container separation and restart.
- The initial unchanged frame fixture failed with `dynamic is undefined`: it
  counted four frames before the new frame had its destination URI. A separately
  authorized follow-up fixes the fixture to await the destination document's own
  end-phase message before reading the value captured by its page script. The
  document-start assertion remains intact. The complete Gecko and WPE frame
  suites now pass, including targeted messaging, dynamic-frame destruction,
  stale IDs, history and teardown (`/tmp/basilisk-frame-phase-fix.log`).
- Enabled fixtures log `engine-session.js:10: gBrowser is null` while also
  reporting their successful assertions. That shared upstream file remains
  unchanged; the previous session's related fix was not carried forward.

The reused object directory initially retained five dangling chrome/module links
into discarded source files. Those generated links were removed; no source file
was restored. The packaged application was tested independently. A generated
`.purgecaches`/staging deletion race also required preserving the leftover
cache-only staging directory before restarting the build; UXP was not changed.

Validation logs are `/tmp/wpe-upstream-refresh-build-resume.log`,
`/tmp/wpe-upstream-refresh-final-source.log`,
`/tmp/wpe-upstream-new-sdk-host.log`, `/tmp/wpe-upstream-content-bridge.log`,
`/tmp/wpe-upstream-relocated-https.log`,
`/tmp/basilisk-upstream-port-build-final.log`,
`/tmp/basilisk-upstream-disabled-build.log`,
`/tmp/basilisk-upstream-port-package-audit.log`,
`/tmp/basilisk-upstream-enabled-packaged-smoke.log`,
`/tmp/basilisk-upstream-disabled-smoke.log`,
`/tmp/basilisk-upstream-containers.log`, and `/tmp/basilisk-upstream-frames.log`.
These checks do not claim a complete upstream addon or lifecycle regression run.
