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
  a **GdkWindow**, not a GtkWidget. Without client-side decorations its owner
  is the GtkWindow containing a windowless MozContainer; with decorations it
  is the MozContainer. `mozcontainer.h` supplies native child parenting and
  geometry. UXP's GTK/GLib event loop dispatches WPE callbacks.
* The GTK symbol shim permits GTK2 NPAPI processes. Additional GTK3 host
  functions are resolved inside the integration instead of linking GTK3
  directly into libxul. Component registration is restricted to the main
  process. A native child window clips Gecko's compositor output; its damage
  is processed at the WPE presentation tick, independently of Gecko painting.
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

This machine is Linux/LoongArch64 with GTK3 and WebKitGTK installed, but initially
had no WPE pkg-config modules or WPE shared libraries. WebKitGTK is not a fallback.
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
Both disabled and enabled full builds completed. Upstream WPE configuration needed locally
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
not yet implemented or validated. This remains a development experiment; the
basic view checks below do not establish complete browser compatibility.

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

For this checkout's private dependency installation, the launch command is:

```sh
mkdir -p build-wpe-deps/my-test-profile
LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  obj-webkit-enabled/dist/bin/basilisk -no-remote \
  -profile "$PWD/build-wpe-deps/my-test-profile" \
  -chrome chrome://browser/content/webkit/prototype.xul
```

Use `lib` instead of `lib64` if that is where your WPE installation places its
libraries. Install WPE's helper executables and resources with the library;
copying only its shared object is insufficient. No runtime sandbox was disabled
for the validation here. WPE web processes ran through upstream's bubblewrap
sandbox, alongside Gecko's existing process setup.

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
  -ldl -o build-wpe-deps/host-smoke
build-wpe-deps/host-smoke
```

It requires real frame delivery and checks load/title plus ten create/destroy
cycles. It is not proof of XUL integration, keyboard/mouse operation, HTTPS,
history, or absence of leaks. Those remain separate runtime gates.

The XUL lifecycle test additionally exercises the actual XPCOM component:

```sh
DISPLAY=:91 LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64" \
  python3 tools/wpe/run-lifecycle.py obj-webkit-enabled
```

Supply an existing test display (the checks here used Xvfb), and do not run
concurrently with a build in that object directory. The runner creates a fresh
profile and loopback server, temporarily stages two test chrome resources in
the enabled build, and removes them afterward. It asserts URI/title changes,
back/forward state and navigation, reload with a changed server response,
cancellation of a delayed load, hide/show, and ten attach/destroy cycles.
Mouse/keyboard, continuous rendering and XUL context menus require separate
interactive checks; this harness does not claim to test those.

### Completed disabled-build checks (2026-09-25, Linux/LoongArch64)

* Default and explicit-disabled configure both completed with a pkg-config
  guard rejecting any WPE/WebKit query; no forbidden queries occurred.
* The corrected disabled full build completed. A subsequent normal make
  invocation returned status 0.
* `check-disabled.py` passed across 30 ELF files, checking direct/transitive
  dependencies as well as defines, backend traversal, registration, interfaces
  and resources. Auxiliary ELF inspection uses the application library path,
  as the launcher does.
* The final disabled browser rendered Example Domain and Wikipedia over HTTPS
  in ordinary Gecko tabs on an isolated Xvfb display and test profile. Tab
  switching, creation, closing and history navigation were smoke-tested.
* Enabled configure rejects absent WPE packages. Against the fetched upstream
  build metadata it completes and traverses the enabled component.

An early implementation returned False from the configure dependency, which
this tree serialized into an empty C define. The disabled artifact audit
caught it. The final configuration returns None and completely omits the
feature define. The audit retains that check.

### Completed enabled-view checks (2026-09-25, Linux/LoongArch64, GTK3/X11)

* WPE 2.54.0 built from the verified upstream source and was installed under
  the private prefix. Basilisk's normal enabled make completed with status 0.
* ELF inspection finds `libWPEWebKit-2.0.so.1` and `libmozgtk.so` in the enabled
  libxul dependency list, with no direct GTK3 linkage. The disabled build has
  no direct or transitive WPE/WebKit dependency.
* The production native host test passed ten load/title/frame/destroy cycles.
* The dedicated XUL view rendered Example Domain and Wikipedia over HTTPS.
  A changing local page repainted its counter and alternating background
  without additional input or exposure. Resizing updated the native rectangle.
* Mouse clicks focused a real WebKit input; typed text rendered and changed
  the XUL window title. Focus returned to the XUL location field for navigation.
  Back/forward toolbar commands worked. Right-click on a link produced the
  XUL popup, and its link command navigated the WPE view to the correct URL.
* The XUL lifecycle test passed ten cycles with 360 state notifications,
  including back/forward/reload and stop before a delayed response completed.
  No crash or accumulating native child windows was observed. This is a
  smoke test, not a heap-leak proof. WPE may retain shared process-pool caches
  beyond an individual view's lifetime; application exit ended its processes.
* A normal window-manager close removed the WPE window and its native child
  while ordinary Gecko tabs remained usable in the same process. Gecko tabs
  loaded Example Domain/Wikipedia, switched, opened and closed normally.

The first **dedicated-view** milestone is demonstrated. Ordinary mixed-engine
tabbrowser tabs remain future work. No content-extension/DOM compatibility,
per-site routing, cookie synchronization, ad blocker, or media permission UI
has been added. Existing Gecko/NPAPI implementation and platform sources were
not changed. NPAPI plugins and existing extensions were not exhaustively
runtime-tested; the disabled artifact audit and Gecko smoke tests are the
regression evidence here. Other architectures, GTK CSD, HiDPI, Wayland, IME,
accessibility and long-running memory behavior still need validation.
