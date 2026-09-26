# WPE Inspector, content bridge and routing

This continuation preserves the optional WPE backend, Gecko as the default,
XUL chrome, the normal WPE process model and the separate profile/private stores.
No bundled WebKit/WPE source changes, Gecko DOM proxies, synchronous DOM IPC,
Necko replacements, SpiderMonkey changes or NPAPI changes are involved.

## Inspector and fullscreen

WPE 2.54 exports `webkit_web_view_toggle_inspector` for WPEPlatform hosts.
Upstream creates its Inspector WPE view on the embedding display; Basilisk mounts
that view in a separate XUL window. There is no Inspector frontend fork or Gecko
DevTools target emulation. Developer commands dispatch to the selected engine.
XUL context menus retain upstream's `GAction` for Inspect Element, preserving
WebKit's actual right-click target rather than guessing an element from coordinates.
An interactive check selected `input#test`; the Inspector console changed the real
page title and returned that input's ID. DOM and CSS panels rendered normally.

Basilisk closes Inspector windows on owner-tab closure and WebProcess termination.
Opening/closing through Basilisk's command or the XUL window is supported.
Upstream's WPE `platformCloseFrontendPageAndWindow()` releases its internal view
without a public frontend-closed notification to the embedding host; its own
frontend close control can therefore leave the XUL host window behind. The XUL
window close remains available. Frontend-close notification needs an upstream
embedding API; no private frontend patch was introduced. Docking is not implemented.

Private-mode Inspector is disabled: upstream's WPE inspector creates a persistent
website data store outside the browser profile and provides no public way to
supply the private session. Supporting it safely requires an upstream storage
configuration API. Ordinary WPE private content still uses its ephemeral session.

Fullscreen acknowledges WPEPlatform toplevel transitions through XUL's existing
window fullscreen state. An ordinary XUL notification takes space above the
native content surface, providing visible exit UI; floating overlays cannot
reliably cover a native child. Escape, native leave-fullscreen, tab selection,
view destruction and process termination restore the previous window state.

## Privileged asynchronous API

In enabled builds every browser has read-only `contentEngine` (`gecko` or
`webkit`) and `contentAPI` properties. Example chrome code:

```js
const api = gBrowser.selectedBrowser.contentAPI;
const result = await api.executeScript("return document.title;");
const style = await api.insertCSS(".advert { display: none !important; }");
await api.removeCSS(style);

api.addMessageListener(message => dump(JSON.stringify(message) + "\n"));
await api.executeScript(`
  browserContent.addMessageListener(message => {
    browserContent.sendMessage({echo: message, title: document.title});
  });
`);
await api.sendMessage({hello: "content"});

await api.registerScript("my-extension:start", `
  document.body.dataset.modified = "yes";
  browserContent.sendMessage({loaded: location.href});
`);
await api.unregisterScript("my-extension:start");
```

* `executeScript(source)` accepts an **async function body**. Use `return` for a
  result; promises are awaited. Results/messages are explicitly JSON serialized.
  Undefined results become null. Exceptions and nonserializable results reject.
* `sendMessage(value)`, `addMessageListener(fn)` and `removeMessageListener(fn)`
  exchange JSON data. Inside the isolated world the corresponding frozen API is
  `browserContent`. No XPCOM/native pointers or privileged XUL objects cross it.
* `insertCSS(css, optionalToken)` returns a token; `removeCSS(token)` removes it.
  Sheets use the backend's user stylesheet support and apply to the current and
  subsequent top-level documents. Tokens are scoped to the browser client.
* `registerScript(token, source)` installs an async body at document end for
  **future top-level documents**; `unregisterScript(token)` removes it. Registering
  does not execute it retroactively; use `executeScript` for the current document.
* Script/style definitions and chrome message listeners survive manual engine
  replacement in the same window. Existing page listeners and DOM state do not.
  Registrations are in-memory, not stored as executable code in session files.
  Cross-window alternate-tab adoption transfers serialized definitions before the
  destination load, but never source-window callbacks/globals. After application
  restart, extensions must register through the destination tab lifecycle.
* Script/CSS inputs and messages are limited to 1 MiB. Operations time out after
  30 seconds. Native WPE operations are cancelled on navigation/destruction;
  process termination rejects pending chrome operations and permits reload.
* The named WPE content world is shared by this privileged API, not a separate
  security principal for each XUL extension. XUL extensions already possess
  chrome privileges. Ordinary page JavaScript does not get the bridge API.

WPE uses supported `call_async_javascript_function`, user content manager,
world-specific message handler, user-script and user-style-sheet APIs. Gecko uses
an ordinary dedicated frame script and content-principal sandbox with Xrays.
Existing Gecko frame-script globals, extension messages and DOM getters are not
replaced. The bridge sandbox hides the legacy content `Components` shim.

`ContentEngineState` is a bubbling **XUL browser event**, not a fake content DOM
load event. Its frozen detail supplies engine, URI, title, loading, back/forward,
muted and audio-playing state. It does not fabricate a channel, TLS identity,
Gecko progress request, favicon or foreign Document.

## Extension compatibility matrix

This extends the source audit in [wpe-persistent-integration.md](wpe-persistent-integration.md).

| Extension surface | Status |
| --- | --- |
| XUL menus/toolbars/sidebar/preferences, chrome stylesheet service | Works unchanged; real installed fixture verifies menu UI and tab observation |
| Tabs, URI/title/navigation, loading, mute, engine identity | Browser abstraction; neutral state event available for both engines |
| Standards-based scripts, DOM modification, async results/messages | `contentAPI` on each engine's real DOM; extension adaptation needed |
| Content CSS insertion/removal | `contentAPI`; no cross-engine effect from Gecko stylesheet services |
| Existing Gecko frame scripts/message managers | Unchanged for Gecko; WPE needs explicit portable bridge use |
| Existing synchronous contentDocument/contentWindow/nsIDOM/layout code | Gecko only; WPE getters remain null, never fake objects |
| nsIContentPolicy/nsIChannel/HTTP observers | Gecko only; no fabricated WPE channels |
| Procedural/cosmetic ad blocking | Script, CSS and message foundations available; no full blocker implemented |
| Alternate network filtering | Normal WPE views expose generic URL/type block rules; see [shim contract](content-engine-shim.md). Gecko networking is unchanged |
| Gecko DevTools actors/targets | Gecko only; WPE dispatches to upstream Inspector |

The profile-installed test extension under `tools/wpe/extension` exercises fixtures
A–F: chrome UI/tab observation, URI/title state, removable CSS, async DOM modification
and JSON result, round-trip messaging, and native Gecko versus unsupported WPE DOM
getters. It also remains active across engine switches. This is not certification
of arbitrary legacy extensions or an existing third-party ad blocker.

## Per-site routing

Optional string preferences:

```js
user_pref("browser.contentEngine.default", "gecko");
user_pref("browser.contentEngine.siteRules",
          "{\"chatgpt.com\":\"webkit\",\"legacy.example\":\"gecko\",\"https://example.org\":\"default\"}");
```

Rules match canonical exact hosts or HTTP(S) origins; origins take precedence over
hosts. No substring, implicit suffix/wildcard or subresource matching occurs.
`default` falls back to the global preference, which defaults to Gecko. Invalid
rules are reported and ignored as a set. No rules are installed automatically.

Precedence: explicit manual tab override > origin/host rule > global default.
New WPE Tab and Reload with either engine set a persistent SessionStore tab override.
To clear it from privileged chrome:

```js
SessionStore.deleteTabValue(gBrowser.selectedTab, "basilisk.engineOverride");
```

Only top-level HTTP(S) **GET** navigations are routed. WPE uses its response-policy
API's explicit main-frame/main-resource indication; Gecko uses its existing
per-tab top-level location callback and real request method. WPE routing occurs
before committing a supported response; Gecko may already have committed the
navigation when the replacement GET is issued. This is not a network/privacy
firewall: the first engine may have contacted the destination. POST bodies are
never replayed. Unsupported MIME/download responses stay with their backend.
Engine switches are deferred out of native callbacks and reload the destination.

A short bounded chain prevents repeated cross-engine redirects; a blocked chain
sets `contentroutingblocked` on the tab and retains the active engine. Explicit
manual switching resets this guard. Session restoration honors saved engine
identity, even if site rules changed. Cookies and storage remain engine-specific.

## Validation and remaining limits

Run against a finished unpackaged enabled build, never while rebuilding it:

```sh
export DISPLAY=:91
export LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64"
python3 tools/wpe/run-advanced.py obj-webkit-enabled
python3 tools/wpe/run-lifecycle.py obj-webkit-enabled --cycles 100
python3 tools/wpe/run-lifecycle.py obj-webkit-enabled --mixed --cycles 100
python3 tools/wpe/run-stress.py obj-webkit-enabled
python3 tools/wpe/run-stress.py obj-webkit-enabled --mode shutdown
python3 tools/wpe/run-stress.py obj-webkit-enabled --mode switching
python3 tools/wpe/run-persistence.py obj-webkit-enabled
python3 tools/wpe/check-disabled.py obj-webkit-disabled
```

The stress runner kills only WebProcesses descended from its own fresh-profile
browser. It never uses a global process-name kill. Its shutdown mode quits with
20 active WPE loads, an open Inspector and the XUL extension installed.

The existing unsupported-permission-origin blocker is unchanged; those requests
remain denied. No origin substitution or bundled source patch was made. Complete
transparent legacy content-extension compatibility is intentionally unavailable.
Inspector network/storage/debugger/media panel parity and long-duration real-site
soak testing are not implied by the fixture results. See the recorded results
below for the exact tested coverage.


### Recorded results, 2026-09-26

Native platform: Linux LoongArch64, bundled upstream WPE 2.54.0. The tested WPE
CMake configuration has `ENABLE_C_LOOP=ON`, `ENABLE_JIT=OFF`, `ENABLE_DFG_JIT=OFF`
and `ENABLE_FTL_JIT=OFF`.

| Check | Result |
| --- | --- |
| Enabled incremental build | Passed; libxul has the expected libWPEWebKit-2.0.so.1 dependency |
| Disabled incremental build + dependency/packaging audit | Passed; 30 ELF files, no direct/transitive WPE dependencies, feature define, component registration, interfaces or WPE resources |
| Native component lifecycle | 100 attach/destroy cycles passed, including URI/title, back/forward, reload and stop; 4,800 observer notifications |
| Mixed browser lifecycle | 100 WPE→Gecko→WPE round trips (200 replacements) passed, stable expected native-view count |
| Installed XUL extension A–F | Passed on both engines; CSS removal, real DOM changes, MutationObserver, page-world isolation, rejected exceptions and round-trip JSON messages |
| Registrations during switching | 100 additional Gecko→WPE→Gecko round trips passed with the XUL extension installed, checking CSS/script registration and API identity after each of 200 replacements |
| Routing | Exact hosts/origins, manual precedence, clearing override, top-level cross-host redirect and subframe isolation passed |
| Restore versus rules | Saved Gecko and WPE identities survived changed rules; subsequent explicit navigation resumed routing |
| Cancelled switch | No replacement tab or manual override change when Gecko denies permitUnload |
| Multi-tab stress | 20 simultaneous WPE tabs alongside Gecko; selection and bulk close passed |
| Inspector lifetime | 10 open/close cycles, switching selected tabs, closing the inspected tab passed |
| Crash recovery | Killed 21 test-owned WebProcesses with Inspector open; pending script rejected, Inspector closed, reload and extension operations passed |
| Tab movement | 20 cross-window adoptions, detachment and window close during navigation passed |
| Active shutdown | Quit with 20 loading WPE tabs, Inspector open and XUL extension installed; exit status 0 |
| Profile restart | Persistent cookies/localStorage/IndexedDB, mixed session order/pinning/selection, shared normal storage and private isolation passed |
| Interactive Inspector | Actual right-clicked input selected; DOM/CSS display and console execution passed |
| Interactive fullscreen | Native fullscreen enter, visible XUL exit UI and Escape restoring both document/chrome state passed |

No Basilisk crash was observed. The native-cycle main-process RSS samples stayed
approximately 344–351 MiB after warm-up; this is not a leak-proof result or a
sanitizer run. WPE process caching is expected. Logs included Mesa experimental
platform notices and occasional sandbox D-Bus disconnect warnings on shutdown;
these did not prevent clean exit. No WPE WebProcess or NetworkProcess remained
after the test browsers exited. NPAPI and arbitrary third-party Gecko extensions
were not separately exercised in this continuation; their implementations remain
unchanged. Full Inspector network/storage/debugger/media-panel coverage and
long-running authenticated-site soak tests remain additional validation work.
