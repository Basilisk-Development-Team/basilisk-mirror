# WPE tab integration

This records the first mixed-tab milestone. For the subsequent persistent
storage, session restoration and adoption work, see
[Persistent WPE integration](wpe-persistent-integration.md). Its implemented
features supersede the ephemeral-storage and adoption limitations below.

## Inspected boundary and incremental plan

The working native host remains authoritative: WPEPlatform owns its display,
view, SHM frames and subprocesses. A native GTK child clips Gecko's compositor;
explicit frame presentation and post-map allocation are necessary. GTK symbols
outside UXP's NPAPI shim are resolved locally. None of this is replaced.

Basilisk's tabbrowser owns more than content navigation: its browser elements
provide frame-loader lifetime, progress filters, session-store messages, focus
and chrome bookkeeping. `nsIWebNavigation` also exposes Gecko documents and
session history; it cannot honestly represent WPE. An application-local chrome
adapter will expose the small navigation/state contract and retain an empty
Gecko frame loader strictly for existing tab bookkeeping. WPE contentDocument
and contentWindow will be null, never proxies or the empty shell's document.
The shell is an explicit transitional cost, not a Gecko implementation of WPE.

Steps, each independently committed and checked:

1. Preserve the PoC and document its boundaries; keep existing build gates.
2. Extend the content-view interface with engine identity, loading/error state,
   editing, zoom/find and media state using inspected WPE 2.54 APIs.
3. Add an enabled-only browser/content adapter and mixed-tab lifecycle, keeping
   Gecko browser methods untouched. Add small explicit chrome integration hooks
   for operations that currently bypass browser navigation (reload/stop/focus).
4. Add manual engine switching and normal location/title/loading updates.
5. Bridge the platform text clipboard, reuse the existing XUL context popup,
   and route user-initiated new-window requests through Basilisk.
6. Validate mixed tabs, switching, input, close/shutdown and the disabled ELF,
   component and resource audit. Preserve the standalone view as a regression
   harness. Stop at the requested usable mixed-tab milestone before optional
   site routing or advanced extension bridges.

Gecko remains the default, including in enabled builds. The adapter never
claims WebKit TLS state is Gecko security state, and never synchronizes storage,
networking or DOMs. Unsupported privileged permissions remain denied. Downloads,
session restore, cross-window tab adoption, content extension compatibility,
rich clipboard data and other non-core parity must be explicitly tracked rather
than silently implemented through the empty Gecko shell.

## Implemented boundary

`nsIWebContentView` is the native, main-process-only interface. It exposes primitive
navigation, state, bounds, focus, editing, find, zoom and audio operations, and
observer notifications carrying property bags. WPE types stay in the component.
`ContentEngines` and `ExternalContentBrowser` are application-local adapters in
`base/content/webkit/content-engines.js`. `engineFor(browser)` returns `gecko` or
`webkit`; Gecko browser instances retain their existing properties and methods.
Only WPE instances adapt chrome-facing properties. Their synchronous DOM getters
return null. Their docshell/message manager still belongs to the inert shell and
must not be used as a content API. No fake DOM, channels or progress requests are
created. Existing Gecko frame scripts remain unchanged.

The working SHM/Cairo native host is retained. Every WPE tab has its own native
view. Only the selected view is mapped; background views continue loading.
TabClose destroys the native view and restores the shell's properties and
progress filter before normal tabbrowser teardown. Native-parent destruction is
also handled. WPE process termination reports an error; reload can retry.
WebKit subprocesses remain outside UXP's content-process architecture.

The tab context menu creates a WPE tab or reloads the URI with either engine.
Switching replaces the tab/content lifetime, retaining position, pinning and
selection but not live state. Gecko beforeunload cancellation is respected.
Gecko remains the default. No automatic site routing is enabled.

Small application hooks route reload, stop, selected-tab focus and location
updates. The identity UI clears stale Gecko security state for WPE; it does not
claim to display WebKit certificate information. Thumbnail capture skips views
without Gecko DOM. All feature-specific hooks, scripts, menu entries and native
sources are build-gated. The generic null guards also safely handle missing
Gecko state. Platform/Gecko, SpiderMonkey and NPAPI implementation are untouched.

`engine-context.js` consumes hit-test primitives and reuses the existing XUL
content popup and command identities. It supports navigation, opening/copying
links and basic editing; unsupported built-in entries are hidden for that popup
and restored afterward. `engine-finder.js` adapts the existing findbar listener
protocol to native WPE search. Page zoom and mute use native backend properties.
Text clipboard data crosses the GTK clipboard asynchronously with owned GObject
references. Native keyboard accelerators return focus to XUL before invoking
browser commands. User-gesture new-window URI requests create Basilisk WPE tabs.

`engine-downloads.js` asks for a destination using the existing save picker. WPE
performs the transfer, then a completed record enters Basilisk's existing download
list. Closing the owner cancels unfinished transfers. There is no silent default
save, separate download-manager UI, or Gecko re-fetch. This is completion-only
integration; active progress, background survival and retry parity remain work.

WPE tabs in one chrome window share an ephemeral WPE network session. Different
windows, including private windows, remain isolated. Closing the window discards
that session. This deliberately does not provide persistent profile storage or
cross-window login continuity, and never accesses Gecko cookie databases.

## Deliberate limitations and remaining PoC costs

* Native GTK child + SHM/Cairo presentation is Linux/GTK3-specific and copies
  frames; accelerated compositing, Wayland coverage, IME and accessibility need
  further work. No architecture-specific code or JSC JIT requirement is added.
* The empty Gecko frame loader is transitional bookkeeping overhead. Gecko-only
  docshell consumers do not automatically become WPE-compatible. Session restore,
  duplicate-tab and cross-window adoption are not implemented for WPE. The latter
  UI paths and WPE tab dragging are disabled to avoid moving only the shell.
* No global Places history/favicons, certificate viewer, print, page save/source,
  full context-menu parity, rich clipboard, find counts/whole-word/highlight-all,
  content fullscreen integration or persistent WPE storage yet. Menu labels for
  the three engine commands are currently English and need localization.
* Unsupported privileged permissions are denied. WPE owns its media and WebRTC;
  there is no Gecko media bridge or automatic permission grant. Audio/mute API
  state is wired, but full media/device coverage is not a completion claim.
* `window.open`/target-blank support forwards user-gesture URIs. It does not
  preserve a script-visible opener relationship, named windows, POST bodies or
  blank-window document writes. Non-user popups are suppressed.
* Chrome-only extensions may work with ordinary chrome, but extensions assuming
  every browser has a Gecko contentDocument/docshell will need capability checks.
  WPE DOM extensions, synchronous DOM proxies and nsIHttpChannel emulation are
  intentionally unsupported. Existing Gecko tabs retain their original APIs.

The next content-script boundary should adapt asynchronous message-manager
concepts to WPE's inspected `WebKitUserContentManager` script-message handlers,
user scripts/style sheets and `webkit_web_view_evaluate_javascript` completion
callbacks. It must use real WebKit DOM inside WebKit, with principal/world and
message validation, rather than forwarding Gecko frame scripts blindly. Future
filter rules belong to backend policy APIs, not synthetic Gecko channels.
Per-site selection should follow lifecycle/session support and use parsed hosts
or origins; it is intentionally not part of this integration milestone.

## Reproducible checks

After completing an enabled build, with a disposable X display and WPE loader
path available (never concurrently with a build in that object directory):

```
DISPLAY=:91 LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64" \
  python3 tools/wpe/run-lifecycle.py obj-webkit-enabled --mixed
DISPLAY=:91 LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64" \
  python3 tools/wpe/run-lifecycle.py obj-webkit-enabled
python3 tools/wpe/check-disabled.py obj-webkit-disabled
```

The runners stage test-only chrome in the object directory, create fresh profiles
and a loopback HTTP server, and remove their staged resources afterward. Mixed
coverage drives real browser chrome: default Gecko, two simultaneous WPE views,
null WPE DOM getters, navigation/back/forward/reload/stop, URL/title, twenty engine
switches, extra create/close, view counts and application shutdown. This is not a
claim that a view-count assertion proves absence of native leaks.

Additional observer payloads (UTF-8 strings unless stated otherwise):

| Topic | Payload |
| --- | --- |
| `content-view-command` | `command`: browser accelerator identity |
| `content-view-new-window` | `uri`, boolean `userGesture` |
| `content-view-find-found` / `content-view-find-not-found` | view subject |
| `content-view-download-request` | `filename`; chrome writes `path`, or leaves it empty to cancel |
| `content-view-download-finished` | `uri`, `path`, `error` (empty on success) |

The download request deliberately uses a writable bag for the existing modal
save picker. The component and download are retained across its nested event
loop; closing the tab cancels the download and disconnects its handlers.

## Results on this checkout (2026-09-25)

Both GTK3 builds completed on LoongArch64 with the locally built official WPE
2.54 dependency, using its interpreter/CLoop configuration. The disabled
configure used a pkg-config guard rejecting WPE queries and passed without
triggering it. The final disabled audit examined 30 ELF files using readelf and
ldd, plus component strings, typelibs and chrome resources: no WPE dependency or
registration. A disabled xpcshell runtime check also found no WPE contract.
Enabled libxul links `libWPEWebKit-2.0.so.1` and retains UXP's `libmozgtk` shim.

The mixed and component lifecycle runners passed and exited zero. Additional
isolated-display checks exercised actual HTTP/HTTPS rendering (Wikipedia),
location-bar typing, redirects/navigation failure handling, tab switching,
keyboard/mouse/wheel scrolling, find highlighting, page zoom, mute setters,
clipboard transfer WPE↔Gecko and WPE↔XUL, XUL link context menus/copy-and-paste,
user-gesture target-blank tabs, cookie isolation and save-dialog downloads with
verified bytes and a completed Basilisk download record. Repeated application
shutdowns completed without an observed product crash. No WPE child processes
remained after the test applications exited.

No known reproducible leak or crash was observed in these checks, but no heap
leak proof, sanitizer run or exhaustive long-duration stress test was performed.
An early test run overlapped rebuilding its own installed modules with shutdown;
that invalid test was discarded and repeated with builds and runtime tests
strictly separated. Existing GMP update certificate-pin failures appeared in
fresh profiles; they were not suppressed or treated as integration successes.
NPAPI and the existing extension suite were not exhaustively tested, and no
claim of full Gecko regression-suite coverage is made.

To try the integrated UI, launch the enabled binary with the WPE library path
and a separate profile, then right-click a tab and choose **New WPE WebKit Tab**
or **Reload with WPE WebKit**. **Reload with Gecko** returns to Gecko. Internal
Gecko/chrome URLs are not WPE pages; switch an HTTP(S) URL or start a blank WPE
tab. Keep a separate test profile until WPE session restoration and persistence
are implemented.
