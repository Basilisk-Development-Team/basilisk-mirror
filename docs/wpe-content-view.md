# Optional WPE content-view prototype

## Inspection and implementation plan

Gecko remains the default engine. WPE is an explicitly enabled experiment;
there is no automatic detection, engine routing, or change to existing tabs.

Relevant boundaries inspected:

* `platform/toolkit/content/widgets/browser.xml` delegates navigation to
  `nsIWebNavigation`, obtains its docshell from the frame loader, and exposes
  Gecko DOM objects. `nsIWebNavigation` itself exposes document/session-history
  interfaces; it is not a suitable WPE contract.
* `basilisk/base/content/tabbrowser.xml` assumes docshells, message managers,
  progress listeners and browser bindings throughout tab creation, activation,
  removal and swapping. A WPE implementation cannot simply replace that binding.
* `platform/embedding/browser/nsIWebBrowser.idl` also exposes Gecko DOM and
  progress-listener interfaces. Leave it and existing extension behavior alone.
* `platform/widget/gtk/nsWindow.cpp::GetNativeData(NS_NATIVE_WIDGET)` returns
  a **GdkWindow**, not a GtkWidget. `mozcontainer.h` documents native child
  parenting and geometry. UXP's GTK/GLib event loop can dispatch WPE callbacks.
* A separate privileged XUL test window with a content-view host is the first
  integration point. This meets the view milestone without pretending that
  tabbrowser's docshell-dependent features work. Ordinary tabs remain Gecko.

Planned independently reviewable commits:

1. Basilisk `moz.configure`: opt-in `--enable-webkit`, explicit
   `--disable-webkit`, `MOZ_WEBKIT`, enabled-only pkg-config checks. No platform
   submodule change is needed for the application-local feature.
2. `basilisk/components/webkit`: small engine-neutral XPIDL interface and
   isolated XPCOM component. No contentDocument/contentWindow emulation.
3. Native view lifetime: host a GTK drawing area inside a privileged XUL
   window, with a WPEPlatform display/view implementation. GTK is only the
   native host/input source, never WebKitGTK.
4. Rendering: WPEPlatform SHM buffers copied to an owned Cairo surface;
   acknowledge rendered/released buffers, resize and hide correctly. This
   deliberately starts with a correctness-oriented software presentation path.
5. Input/focus: native pointer, wheel, key and focus events translated into
   WPEPlatform events. Document IME/accessibility limitations until implemented.
6. Navigation/state: WPE WebView load/reload/stop/history and URI/title signals
   bridged through an engine-neutral listener; handle process termination.
7. XUL: enabled-only test window/resources with navigation controls and
   explicit destruction on unload. No changes to Gecko browser bindings.
8. Context menu: suppress backend UI and send primitive hit-test information
   to a XUL popup. Do not reuse Gecko-DOM-dependent context-menu machinery.

## WPE dependency and API selection

This machine is Linux/LoongArch64 with GTK3 and WebKitGTK installed, but has no
WPE pkg-config modules or WPE shared libraries. WebKitGTK is not a fallback.
WPE WebKit 2.54.0 sources were fetched into ignored `build-wpe-deps/` for API
inspection and a private dependency build. SHA-256:
`efa9bcc3cb891c2d88f50eec710d9ccee71cbdf1040420361eb98c17355eb452`.
Source: https://wpewebkit.org/releases/wpewebkit-2.54.0.tar.xz
Release: https://wpewebkit.org/release/wpewebkit-2.54.0.html
Architecture: https://wpewebkit.org/about/architecture.html

Use `wpe-webkit-2.0` and WPEPlatform, not legacy libwpe/WPEBackend-fdo.
The inspected headers expose WPEDisplay/WPEView subclass hooks,
WPEBufferSHM, wpe_view_buffer_rendered/released, wpe_view_event,
wpe_view_focus_in/out and WebKitWebView navigation/state APIs. The built-in
headless view discards frames; it cannot itself serve as our visible view.
A custom display/view must own presentation and buffer lifetimes. WPE's own
upstream dependency build uses its existing build infrastructure; UXP continues
using moz.build and the existing C/C++ build machinery, with no Rust additions.

WPE owns its web/network processes, storage and content media. UXP retains
chrome and browser policy. No Gecko networking/NPAPI/media changes. Permission
requests must default to denial pending a proper XUL permission UI. Signals must
be disconnected before host destruction, and pending frame callbacks cancelled.

## Future generalization (out of scope)

A Gecko adapter can delegate the limited navigation/state contract to an
existing browser; do not refactor docshell to construct that adapter now.
Content scripting must execute asynchronously inside the actual WPE document,
never manufacture Gecko DOM objects. Filtering and style/script injection can
later be backend operations owned by privileged XUL policy. Engine switching
can recreate the view; cookie synchronization, live DOM transfer and per-site
selection are excluded. NPAPI stays a Gecko capability.

## Validation record

Before edits, the default object directory requested a clobber and points at a
different source checkout. Preserve it; use fresh `obj-webkit-disabled` and
`obj-webkit-enabled` directories. A fresh baseline configure rejects
`--disable-webkit` (unknown option), as expected before adding the feature.

Required gates: disabled/default configure with a pkg-config guard rejecting
WPE queries; disabled full build and ELF dependency inspection; enabled missing-
dependency failure; enabled full build; interactive HTTPS/render/input/focus,
history/title/URI, XUL popup and repeated close/reopen checks. Compilation alone
is not milestone completion. Record any blocked gates explicitly.

Build gate validation: disabled configure completed successfully with a
pkg-config wrapper that rejects all WPE/WebKit queries (none occurred). Enabled
configure fails explicitly on missing `wpe-webkit-2.0 >= 2.54.0`, as intended.
The disabled full build is running. Upstream WPE configuration needed locally
built gperf and unifdef tools; those stay under ignored `build-wpe-deps/`.

## Opening the dedicated test view

In an enabled build, use a separate test profile and launch:

```
basilisk -no-remote -profile /path/to/test-profile \
  -chrome chrome://browser/content/webkit/prototype.xul
```

Alternatively privileged chrome can call `window.openDialog` on that URI.
This is a dedicated XUL window, not an ordinary tabbrowser tab. Its content host
has no `contentDocument` or `contentWindow`; it exposes only the content-view
interface. HTTP(S) and `about:blank` are accepted by the initial load operation.
The WPE network session is ephemeral and separate from Gecko. Permission
requests are denied pending a real browser policy UI. IME, accessibility,
printing, downloads, select popups, dialogs, and browser shortcut parity are
not yet implemented or validated. Never use this experiment for normal browsing
until the runtime validation gates above pass.

## Dependency build and disabled-build audit

`tools/wpe/fetch-source.sh` explicitly downloads and verifies the pinned upstream
source. Nothing invokes it automatically. For a local WPE build, use upstream's
CMake/Ninja support in `build-wpe-deps/wpe-build`, with `PORT=WPE`,
`ENABLE_WPE_PLATFORM=ON`, `ENABLE_WPE_LEGACY_API=OFF`, and an install prefix of
`build-wpe-deps/prefix`. This prototype needs neither the DRM nor Wayland host
backends. This machine also needed `USE_SYSTEM_SYSPROF_CAPTURE=OFF` to use the
upstream bundled dependency. Install build prerequisites or supply private
copies; WPE's upstream build reports missing dependencies. Keep all dependency
source/build/install products in the already-ignored `build-wpe-deps/` directory.
Set `PKG_CONFIG_PATH` to the installed WPE pkgconfig directory when configuring
Basilisk with `--enable-webkit`. The source-build pkgconfig directory can also
be used for development, but its shared library must exist before linking or
running Basilisk.

After a completed disabled build:

```
python3 tools/wpe/check-disabled.py obj-webkit-disabled
```

This audits the feature define, backend traversal, interface installation,
component registration string, loose/archived XUL resources, direct ELF
DT_NEEDED entries and the runtime library dependency closure. It does not
replace interactive Gecko regression testing.

The standalone host runtime smoke test uses the production native host and
requires an X display (an isolated Xvfb display is suitable):

```
c++ tools/wpe/host-smoke.cpp basilisk/components/webkit/WPEHost.cpp \
  -Ibasilisk/components/webkit \
  $(pkg-config --cflags --libs wpe-webkit-2.0 wpe-platform-2.0 gtk+-3.0) \
  -o build-wpe-deps/host-smoke
build-wpe-deps/host-smoke
```

It requires real frame delivery and checks load/title plus ten create/destroy
cycles. It is not proof of XUL integration, keyboard/mouse operation, HTTPS,
history, or absence of leaks. Those remain separate runtime gates.
