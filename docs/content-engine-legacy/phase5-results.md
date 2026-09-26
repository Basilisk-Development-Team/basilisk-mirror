# Phase 5 results — 2026-09-26, LoongArch64

**Implemented and tested: opt-in Basilisk legacy content services. Not achieved:
unmodified uBlock content/bootstrap or network compatibility on WebKit.** The
service-purpose investigation led to real runtime code, not DOM proxies. The
unchanged extension still does not acquire these services through its Gecko loader.

## Commits and repository boundary

* `ae15521`: immutable platform baseline and implementation plan.
* `82ebed4`: independent document worlds and global source execution.
* `e769dcd`: named registrations, explicit world release, process initialization.
* `95b7ff1`: Basilisk runtime, target ownership, queues, snapshots, messages,
  scripts/styles, progress and teardown.
* `eda74d6`: installed-extension fixtures and runtime lifecycle tests.
* `d57c65b`: direct world lookup after process restart, without a global signal hook.
* `4765f3c`: preserve handles across same-document progress, bound UTF-8 message
  queues, snapshot updates, private-window and close tests.

The platform gitlink remains `f865b384ebe9a86d17e0f015482d8b5d7bb283bc`.
Its pre-existing checked-out revision remains
`845e0e1a2ffd48d33a48ca89fa72acc61399395b`; platform working-tree status is empty.
The root's pre-existing ` M platform` is deliberately untouched. No new platform
API/source change or generated alternate-engine platform file was introduced.
All 38,842 regular files in the bundled WPE 2.54.0 source archive were compared
against the extracted tree: **zero differences**. WebRTC and permission policy
were not changed. Production additions contain no extension-identity branch.

## Compatibility matrix

| Purpose | Phase 5 result | Unchanged uBlock connection |
| --- | --- | --- |
| Chrome UI, preferences, extension storage | Native UXP unchanged | Toolbar/dashboard/storage work; popup can open |
| URL values | Existing real nsIURI facilities unchanged | URL representation is not the blocker |
| Persistent sandbox-like content target | Opaque document/frame/world handles; actual isolated WebKit globals | Native `Cu.Sandbox([win], {sandboxPrototype:win})` is not intercepted |
| Ordered loadSubScript | Owned content source runs sequentially at global scope; errors reject asynchronously | Native scriptloader still receives uBlock's native Gecko sandbox |
| Synchronous configuration data | Versioned immutable JSON snapshots, local synchronous lookup | Private filter closure is not discovered or copied; producer must use runtime |
| Async frame messaging | Named messages, local callbacks, frame/context isolation | Native message-manager registrations are not globally redirected |
| Script phases | Real start/end registrations in all/top frames | No generic translation of uBlock's privileged Gecko bootstrap |
| Content CSS | Owned registration/removal, current and future documents | Captured Gecko window-utils bindings remain native |
| Progress/location | Plain generic browser-state callbacks | No fabricated docshell or DOMWindow |
| Standards DOM/procedural code | Can run in actual WebKit DOM, with persistent world state | Clean uBlock bootstrap does not install it there |
| beforescriptexecute cancellation | Not implemented; distinct Gecko-specific contract | Cannot replace with late DOM observation |
| Live request filter callback | No public deferred/attributed all-request WPE API | HTTP-observer filtering remains blocked |
| Compiled pre-fetch policy | Existing API still passes deterministic server counters | Not substituted for uBlock's live closure |
| Gecko DOM/Window/QI semantics | Native for Gecko only | No foreign DOM objects or synchronous DOM IPC |

See [runtime contract and limits](runtime.md), [the source/member trace](member-matrix.json)
and [service-semantics report](service-semantics.md). The content boundary is
missing transparent service acquisition and captured-binding translation, not an
assertion that selectors, persistent worlds or synchronous data reads are impossible.

## Clean unmodified uBlock result

Version **1.16.6.1**, original and disposable-profile installed XPI SHA-256:
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.
No source changes; audit test harness configures rules through the extension's
existing privileged API. Production runtime does not recognize this extension.

The strict audit returned **exit 1**, retained as failure, not reclassified as a
passing compatibility test:

* Gecko: all nine blocked request probes have server count zero; controls load.
  Static/dynamic cosmetics hide targets, picker adds a frame, logger records
  requests, reload increments the page counter, disable/re-enable changes blocking.
* WebKit: all nine blocked probes reach the server; cosmetics remain visible;
  pageStore is absent, policy/location messages are absent, logger has zero test
  entries, picker adds no frame, extension reload leaves the page counter unchanged,
  and per-site toggle does not activate filtering. Toolbar/popup/dashboard/storage
  working does not offset those failures.
* The extension reload uses `browser.webNavigation.reload` at
  `js/vapi-background.js:1117-1123`, bypassing the existing generic browser reload
  helper. This legacy service path remains a separate compatibility gap; no
  nsIWebNavigation/docshell facade is fabricated as part of content execution.

Runtime fixture success therefore does **not** mean uBlock's content half now
initializes. It demonstrates the generally useful facilities an explicit loader
adapter could consume. No extension adaptation was applied. No clean Adblock
Latitude XPI was found in the existing test profile; that optional test was not run.

## Tests performed

| Check | Result |
| --- | --- |
| Enabled incremental build and runtime staging | Pass, LoongArch64 |
| Disabled incremental build / component-resource-ELF audit | Pass; 30 ELF files, no WebKit/WPE dependencies or resources |
| Mechanical generic/backend boundary audit | Pass |
| Two separately installed extension fixtures | Pass: world/target/source ownership and absent privileged content globals |
| Persistent globals + concurrent ordered source loading | Pass |
| Script error association and subsequent queue execution | Pass |
| Versioned/frozen snapshots, updates to live and future documents | Pass |
| Start/end before page scripts, all frames, dynamic frame creation | Pass |
| Targeted messages, UTF-8 queue bound, content CSS removal | Pass |
| Frame destruction with pending operation | Pass |
| Navigation, engine replacement, tab close, process failure | Pass: stale handles/pending work reject |
| Process recovery with registered worlds | Pass |
| Same-document title change while loading | Pass: live target remains usable |
| Private/cross-window ownership and window close | Pass; services are chrome-window scoped |
| 100 world create/release cycles | Pass; approximately 9–10 seconds locally, not a request-filter benchmark |
| Existing mock backend | Pass: lifecycle, capabilities, serialized callbacks |
| Existing Gecko/WebKit frame suite | Pass: timing, CSS, messaging, CSP, stale IDs, history |
| Generic network server-counter suite | Pass: scripts/images/stylesheets/frames/XHR/fetch/WebSockets/redirects blocked before fetch; toggle and independent Gecko controls |
| Existing extension fixtures A–F and routing | Pass |
| Persistent/private data and mixed session restoration | Pass |
| 100 Gecko–WebKit–Gecko engine round trips | Pass, with extension/script/CSS registrations active |
| 20 simultaneous alternate tabs, mixed tabs | Pass |
| 20 adoptions, detach, close during navigation | Pass |
| Inspector open/close, owner close, renderer crash/recovery | Pass |
| Quit with 20 active loads and Inspector | Pass |
| Relocated dist/bin, checkout hidden, no loader environment | Pass; 40 shipped ELF files resolve, helpers/resources application-local |
| Strict unmodified-uBlock acceptance | **Fail on WebKit**, native Gecko controls pass |

Warnings observed in headless testing include Mesa experimental-platform output,
accessibility/D-Bus teardown messages, Inspector debugger-break diagnostics and
an occasional existing URLBarZoom null-window message. No test browser crash was
observed other than deliberate WebProcess kills. No sanitizer run or quantitative
memory/leak profile was performed; no sanitizer-clean or leak-free claim is made.
No test helper process remained after completed test runs. The optional reverse
100-round-trip/native-view-100 matrices from earlier phases were not independently
repeated here; the new 100-cycle test measures **execution worlds**, not native views.

## Reproduction

From this checkout with completed enabled/disabled builds and a test DISPLAY:

```sh
python3 tools/contentengine/run-content-tests.py obj-webkit-enabled legacy
python3 tools/contentengine/run-mock.py obj-webkit-enabled
python3 tools/contentengine/run-content-tests.py obj-webkit-enabled frames
python3 tools/contentengine/run-content-tests.py obj-webkit-enabled network
python3 tools/wpe/run-advanced.py obj-webkit-enabled
python3 tools/wpe/run-persistence.py obj-webkit-enabled
python3 tools/wpe/run-stress.py obj-webkit-enabled --mode switching
python3 tools/wpe/run-stress.py obj-webkit-enabled --mode lifecycle
python3 tools/wpe/run-stress.py obj-webkit-enabled --mode shutdown
python3 tools/wpe/check-runtime.py obj-webkit-enabled --log /tmp/phase5-relocated.log
python3 tools/wpe/check-disabled.py obj-webkit-disabled
python3 tools/contentengine/check-boundary.py
python3 tools/contentengine/ublock/run-audit.py obj-webkit-enabled /path/to/clean.xpi --require-webkit
```

The final command is intentionally still red. Tests use disposable profiles;
fixture source is not installed into the normal browser/profile.

## Remaining work and stop boundaries

1. Transparent legacy loader/service acquisition is still missing. Native Gecko
   document observers, sandbox window arguments and captured privileged closures
   do not begin using a new opt-in API automatically. No global UXP service
   replacement, foreign window, arbitrary privileged source translator or
   extension-specific bypass was introduced. A generally applicable, source-
   preserving mechanism remains unproved, not declared inherently impossible.
2. Live network policy requires an upstream supported request hold/resume plus
   trustworthy metadata. The [separate proposal](request-broker-proposal.md)
   identifies actual internal information, dropped public fields, deferred IPC,
   cancellation, timeout/security semantics and potential shared GTK use. No
   upstream patch or unsupported blocking RPC was attempted.
3. Exact native synchronous loadSubScript exception behavior, arbitrary sandbox
   principal/Xray semantics, Gecko document-idle, per-frame native user styles,
   and before-script cancellation are not promised by this runtime.
4. Message polling is a bounded initial implementation. A future backend-neutral
   world-bound event transport could reduce latency/IPC without weakening identity.
5. Runtime contexts are window/view-owned and close on engine replacement/adoption.
   Callers must open a new context for the destination. Existing generic script/CSS
   registration transfer remains unchanged, but runtime-specific registrations are
   intentionally not replayed into Gecko or retained through an expired owner.

No permission-origin/WebRTC workaround, UXP change, WebKit patch or uBlock patch
was needed for the independent content services delivered here.
