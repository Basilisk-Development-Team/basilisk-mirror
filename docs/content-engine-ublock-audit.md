# uBlock Origin compatibility audit

Target: the user's installed, unmodified uBlock Origin **1.16.6.1** XPI,
`uBlock0@raymondhill.net.xpi`, identifying UCyborg/uBlock-for-firefox-legacy as
its upstream. SHA-256:
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.
The harness copies that XPI into a disposable profile; it never changes the XPI,
the normal profile, the extension's source or production browser behavior for
an extension ID. Extension identifiers appear only in this specific test harness.

Source paths/line numbers below are inside that exact XPI. Extracted sources used
for investigation reside in the ignored `build-wpe-deps/ublock-audit` directory.
No third-party extension source is vendored in the browser patch.

## Runtime method and observations

`tools/contentengine/ublock/run-audit.py OBJDIR XPI` uses the existing extension
settings API to add a local script-block rule and a hostname-specific cosmetic
rule, waits for rule compilation, then opens identical loopback pages in Gecko
and WebKit. The server independently records requests to the blocked resource.
The test reads both pages through the generic asynchronous content API; it also
observes the extension's real Gecko message channels, toolbar, dashboard, storage,
and background page store. Access to the background bootstrap scope is test-only
instrumentation, not a compatibility feature shipped in Basilisk.

Initial measured results:

* Gecko: external script did not execute; cosmetic target had `display:none`;
  uBlock received content-policy/location messages and populated the correct
  page-store URL.
* WebKit: external script executed; cosmetic target remained `display:block`;
  no matching content-policy/location messages arrived; uBlock had no page store
  for the tab. Its existing tab API nevertheless returned the correct browser
  URI/title through the chrome-facing browser properties.
* The dashboard loaded. No uBlock script errors were reported during that run.
* The first toolbar probe used the Australis ID and was incorrect. Source tracing
  showed the installed extension chooses its legacy toolbar path on this UXP
  platform version. The follow-up probe uses the extension's actual toolbar ID;
  this is a test instrumentation correction, not an extension/browser workaround.

## Dependency classification

| Dependency / source evidence | Category | Consequence and appropriate boundary |
| --- | --- | --- |
| `bootstrap.js:createBgProcess`, `getWindowlessBrowserFrame`, `waitForHiddenWindow` | XUL/chrome API | Background iframe and XPCOM startup remain Gecko chrome; startup succeeds |
| `vapi-background.js:323` storage implementation | Extension storage | SQLite under profile extension-data remains chrome-owned; never replace with WebKit website storage |
| `vapi-background.js:2429`, 2643–2815 toolbar path selection and placement | XUL/chrome API | XUL button/panel can remain unchanged; platform-version-based legacy choice is independent of selected content engine |
| `vapi-background.js:888–915` `vAPI.tabs.get` | Tab/browser-state API | Existing currentURI/contentTitle adapters already return the correct WebKit state |
| `frameScript.js` and `frameModule.js:595–620` LocationChangeListener | Gecko docshell / browser-state API | Listens to the real shell docshell, not the foreign page. An extension adapter should use `ContentEngineState`; do not fabricate docshell progress |
| `vapi-background.js:2325–2400` navigation and pending-request bookkeeping | Messaging / browser state | Depends on the preceding frame messages. Missing foreign navigation means no page store, counters or meaningful per-page popup state |
| `vapi-background.js:1687` global loadFrameScript; `frameModule.js:315–440` content sandbox | Content-script / Gecko DOM API | Cu.Sandbox, real Gecko windows and observer-created documents do not reach WebKit. Portable page scripts must be explicitly registered/executed through contentAPI |
| `frameModule.js:348–364` injectCSS/removeCSS | Stylesheet API / Gecko window utils | Gecko user sheets never style WebKit. Generic CSS registration/removal is the appropriate equivalent |
| `vapi-client.js:274–308`; `frameModule.js:401–431` | Messaging API | Add/remove listener and sendAsyncMessage globals are supplied by the Gecko sandbox. The named-world JSON bridge can carry equivalent portable messages, but cannot silently replace the original child-global contract |
| `frameModule.js:97,107,297–302` sendSyncMessage/sendRpcMessage | Synchronous Gecko messaging | Not mapped; synchronous DOM/privilege IPC will not be added. Adapt initialization/filter data distribution asynchronously |
| `frameModule.js:237–302` shouldLoad | Content policy / Gecko DOM dependency | Receives nsIURI, context nodes/windows, frame IDs and Gecko content types. WebKit must not supply counterfeit versions |
| `vapi-background.js:1839–1884,2027–2250` HTTP observer and channel-event sink | Gecko networking/internal dependency | Actual nsIHttpChannel cancellation, redirects, headers and response processing never see WebKit traffic. A separate declarative request policy can cover a safe subset |
| `vapi-background.js:1130` reload via browser.webNavigation | Gecko docshell API | Acts on the shell. An adapted extension should invoke browser.reload/content-view navigation; do not fake nsIWebNavigation |
| `vapi-background.js:1153–1175` injectScript and element picker commands | Content script / messaging | Sends to the shell message manager. Cosmetic/procedural scripts and picker require portable bridge adaptation |
| `vapi-background.js` popup creation and header/CSP processing | Navigation/network APIs | Normal popup UI can remain XUL, but opener/frame/request attribution and response-header rewriting are not supplied by the current shim |

A successful chrome UI does not imply effective blocking. Conversely, the absence
of a JavaScript exception does not indicate compatibility: most failures here
are missing event delivery and enforcement, not thrown startup errors.

## Generally useful primitives and limits

Existing script, CSS and JSON-message operations already support real-DOM changes,
MutationObserver, persistent document-end registration, and in-memory transfer
across engine replacements. They do not provide a synchronous Gecko sandbox,
Gecko globals, arbitrary frame-script source compatibility, or native channel
objects. Scripts needing earlier document timing or all-frame semantics require
explicit additional contracts rather than blind injection of Gecko frame scripts.

The public WPE user-content-filter store/manager can compile and install declarative
rules. URL/resource-class matching can be implemented without guessing origins or
bringing WebKit network objects into XUL. Native engine evaluation retains its
normal network/process model. This does not transparently connect uBlock's
nsIContentPolicy/HTTP observer to that policy API: uBlock's platform adapter would
need to export appropriate rules and consume portable browser/content events.

No origin-aware imperative request callback is promised. UI-process navigation
policy is not a general subresource policy; web-process-extension `send-request`
does not supply the required per-request frame/security-origin identity. Its page
URI is not a replacement for the requesting frame's origin. Redirect/header/CSP
modification, precise per-request counters, and dynamic per-frame decisions remain
unsupported until an appropriate supported API and portable contract exist.

No uBlock filtering engine, extension-ID branch or fake Gecko object belongs in
the browser. The required compatibility work is an extension platform-adapter
change plus reusable primitives—not an assertion that this unmodified extension
now blocks WebKit content.

Follow-up UI/storage run: the actual `uBlock0-legacy-button` was present,
extension SQLite set/get returned the stored value, the dashboard loaded, and
WebKit's selected-tab popup loaded `chrome://ublock0/content/popup.html` with title
`uBlock Origin - Audit page`. The programmatically opened Gecko popup closed
before sampling (about:blank); the harness does not call this a successful Gecko
popup interaction. This UI automation limitation did not affect the successful
Gecko network/cosmetic control or the reproduced WebKit failures. Neither run
reported a uBlock script exception. Missing page-store/request/content events
remain the concrete WebKit compatibility failures.

## Implemented portable policy and upstream boundary

Phase 3 adds `setRequestRules(token, rules)` / `removeRequestRules(token)` with
canonical HTTP(S) URL-prefix and stable resource-type matching. The WPE adapter
uses upstream declarative content filters, not a JavaScript network interception
loop. Replacement is atomic, removal invalidates pending compilation, and rules
stay scoped to their view. Script/style/policy definitions transfer before the
first destination navigation on switching or alternate-tab adoption. The focused
test verifies actual page execution/fetch outcomes, isolation and cancellation.
No uBlock rule parser or extension-specific production behavior was added.

Exact upstream 2.54 source evidence for the remaining attribution gap:

* `Source/WebKit/WebProcess/InjectedBundle/API/glib/WebKitWebPage.cpp`, the
  `send-request` signal, supplies a page, URI request and redirected response.
  It permits cancellation/request-header modification, but does not supply the
  requesting frame, trustworthy requesting origin or typed resource context.
* `Source/WebKit/WebProcess/Network/WebLoaderStrategy.cpp:540–575` internally
  carries `sourceOrigin`, `topOrigin`, `documentURL` and `isMainFrameNavigation`.
  Frame IDs also exist in loader tracking parameters. Those internal objects
  are not a public per-request attribution API for this adapter.
* The smallest useful upstream addition would be immutable request-context
  metadata on an interception hook: stable frame/request IDs, actual source/top
  security origins (including opaque/unknown states), resource class and
  navigation classification. An embedder could enforce preinstalled policies
  locally without synchronous UI-process callbacks. Other content blockers and
  embedders would benefit from the same trustworthy metadata.

Header modification itself is **not** inherently an upstream blocker: the public
web-process-extension signal permits it. A separate extension module and a stable
portable contract would be additional adapter work. What cannot safely be promised
through that signal today is origin/frame-sensitive policy based on metadata it
does not expose. Likewise earlier/all-frame scripts are future generic API work,
not a reason to patch upstream or pretend arbitrary Gecko scripts are portable.

The permission-origin issue remains unchanged and denied. The Inspector's
frontend-close notification/private-store configuration limitations are recorded
separately in the Inspector documentation. No upstream source changes were made.

Final unmodified-extension rerun after the portable policy implementation still
shows the same Gecko success and WebKit blocking/cosmetic/page-store failures.
That is expected without an extension adapter; the successful generic filter
fixture is not presented as uBlock compatibility. The final forced-shutdown log
also contains `settings.js:250` (null details) and `vapi-background.js:1592`
(message sender no longer initialized). These late extension storage/message
callbacks occur during harness shutdown; they were not present in the earlier
UI sampling and are not evidence of a successful error-free extension lifetime.
No extension-specific production workaround was introduced for them.
