# Phase 4 service-semantics reassessment

Source investigation only. No production shim, extension modification, WPE change,
or new feasibility claim based on a mocked result. Target: the unmodified XPI
1.16.6.1, SHA-256 `9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.
Extension callsites below are paths/lines inside that XPI. WPE paths are relative
to pristine `wpewebkit-2.54.0/Source`; UXP paths are relative to `platform`.

**Revision of the previous conclusion:** the earlier statement that Sandbox and
Gecko-window usage collectively make the *purpose* of content bootstrap impossible
was too conservative. Several services are representable without DOM proxies.
However, representing their purpose is not yet a transparent implementation of
the unchanged code's observable contract. The proven declarative network filter
also must not be confused with an existing privileged-JS request callback.

Classification used here:

* **A:** purpose supported by existing generic facilities.
* **B:** needs a new generic service/facility or binding contract.
* **C:** unchanged caller requires synchronous privileged-JS decision/data dispatch.
* **D:** required trustworthy request metadata is not exposed by public WPE APIs.
* **E:** literal unchanged execution path requires a real Gecko DOM/window.
* **F:** retaining that caller in SpiderMonkey while returning live foreign DOM
  results would require synchronous cross-process DOM access.

A row can have more than one class. E/F are qualified by execution placement;
they do not imply that ordinary DOM work cannot execute locally inside WebKit.
A/B do not claim that an unchanged extension automatically consumes the facility.

## 1. Network execution: two different paths

The successful existing path is:

```
privileged contentAPI.setRequestRules
  -> project-owned declarative rules
  -> WPERequestFilters.cpp: compile/save a WebKitUserContentFilter
  -> install compiled filter in the view's user content manager
  -> compiled policy distributed through normal WebKit process machinery
  -> WebCore evaluates resource attributes against compiled rules
  -> block result stops resource loading before network fetch
```

There is **no call to uBlock, SpiderMonkey or an XPCOM observer at the resource
match**. The callback in `WPERequestFilters.cpp:138-158` is completion of filter
compilation/installation, not a request-decision callback. Its inputs do not
include a pending request. Rules were supplied in advance by a privileged client.

Exact engine evidence:

* `WebCore/loader/cache/CachedResourceLoader.cpp:1258-1274`: computes resource type,
  calls `processContentRuleListsForLoad`, obtains `shouldBlock`, and returns a
  blocked resource/error instead of starting the normal load.
* `WebCore/loader/ResourceLoader.cpp:405-413`: repeats the check for redirects and
  invokes the completion handler with an empty request on block.
* `WebCore/contentextensions/ContentExtensionsBackend.cpp:243-290`: builds
  `ResourceLoadInfo`, matches compiled actions, sets `blockedLoad`.
* Some network-side loads use
  `WebKit/NetworkProcess/NetworkLoadChecker.cpp:622-644`: the NetworkProcess also
  evaluates compiled content rules. Thus "all filtering runs in the WebProcess"
  would be too broad. None of these evaluation paths runs Basilisk privileged JS.

The separate public hook is:

```
WebKit WebProcess: PageResourceLoadClient::willSendRequestForFrame
  -> synchronous GLib WebKitWebPage::send-request signal
  -> boolean return
       true: empty the ResourceRequest, cancel
       false: copy any changed request back, continue
```

`WebKit/WebProcess/InjectedBundle/API/glib/WebKitWebPage.cpp:313-326` shows the
entire return boundary. The decision must be available **before g_signal_emit
returns**. Retaining a GObject request reference extends object lifetime, not the
network decision lifetime. `webkit_web_page_send_message_to_view` at :935 provides
asynchronous completion; it supplies no public request suspend/resume token.

### Can that hook call privileged SpiderMonkey synchronously?

Not by an ordinary function call. The hook is executing in a separate WebProcess
with JavaScriptCore; the live extension closure, its UXP services and SpiderMonkey
heap reside in the Basilisk process. The adapter's WebProcess extension does not
link/load libxul, and copying a function's source does not copy its captured filter
engine, storage, page stores or privileges.

The primary obstacle is **process/address-space separation plus absence of a
public deferrable decision API**, not a discovered re-entrancy bug. Thread affinity
is an additional requirement for any proposed broker: privileged extension JS
must execute on its owning browser runtime/thread, not an arbitrary worker. Even
if both processes call their respective thread "main", their heaps are separate.

A browser-process native callback on the correct thread *can* synchronously enter
privileged JS—Gecko already does it. uBlock's `vapi-background.js:2039-2058` consumes
`onBeforeRequest(...)` immediately, then calls `channel.cancel` or `redirectTo`.
That is **C**, not synchronous DOM access. If an engine could hold the request,
an async engine-to-browser transaction could contain this synchronous browser-
local JS call without synchronous cross-process DOM IPC.

A custom blocking RPC or nested event loop in the WebProcess is technically a
possible new design, not a physical impossibility. It is not supplied by the
current generic API/public WPE hook; it introduces blocking cross-process calls,
re-entrancy/deadlock/shutdown questions, and does not solve missing metadata. This
investigation does not propose it as an approved solution or silently introduce it.
Returning allow before the reply loses pre-fetch blocking. Returning block then
replaying loses the original request's body, credentials, initiator and lifecycle
semantics. Neither is equivalent.

### Other public/internal hooks do not close this timing gap

`WebKitWebResource::sent-request` (`UIProcess/API/glib/WebKitWebResource.cpp:133`)
is explicitly after sending. `WebKitWebView::resource-load-started` is an
observation, not a suspension API. `decide-policy` (:2141 in WebKitWebView.cpp)
can defer navigation/new-window/response policy, not every script/image/XHR/socket.
A navigation-only broker is a plausible **B/C** subset, not general network parity.

Content-rule notifications also do not let the embedder choose the current
request's result. Internal matched-rule reporting includes more attributes
(`ContentExtensionsBackend.cpp:340-348`, `WebChromeClient.cpp:1383`), but it reports
an already matched rule through WebKit's internal navigation-client machinery;
it is not an exposed WPE synchronous observer/allow-block callback. An existing
internal IPC message is not a public GLib embedding API.

## 2. Timing and metadata are independent

uBlock's immediate `onBeforeRequest` input is exactly `{frameId, parentFrameId,
tabId, type, url}` at `vapi-background.js:2039-2046`. It derives first-party context
from its page/frame stores populated by location and document events. It does not
read an origin field or HTTP method from that callback. Its HTTP adapter obtains
those five values through URI, loadInfo, load context, and pending shouldLoad
bookkeeping (:1975-2021, :2134-2223). Header/CSP processing is a later, separate
contract (:2072-2116). This distinction avoids requiring unused metadata while
still requiring correct document attribution.

| Datum | Compiled matching internals | Public send-request | Truthful browser/frame derivation |
| --- | --- | --- | --- |
| Request URL | Yes | `webkit_uri_request_get_uri` | A real UXP nsIURI can parse it; **A** |
| Current HTTP method | General loader uses document-loader method; ping path uses request method | `webkit_uri_request_get_http_method` | Available directly; not consumed by this uBlock callback; do not substitute document method |
| Request headers | Not exported through generic rules | Request's HTTP headers | Read/mutation possible at immediate hook; not equivalent to response headers |
| Owning view/tab | Native page/provider | Page object | Backend can tag event with project-owned view/tab ID and generation; **B**, no DOM needed |
| Resource type | Known by native loader/matcher | Not supplied | Cannot reliably infer from URL, Accept, extension, DOM scraping or fetch/XHR overlap; **D** |
| Requesting frame ID | Loader knows frame | Not supplied | Existing frame registry has IDs, but no request-to-frame join key; **D** |
| Parent frame ID | Loader frame tree | Not supplied | Generic getFrames currently returns frameId/documentURI/isTopFrame, not parent; **B** for frame hierarchy itself, **D** for request association |
| Initiating document URL | Loader/document | Page URL only | Current selected/view URL can be provisional/new while old document requests finish. Cannot substitute it as the requesting document; **D** |
| Top-level URL for this request | Matcher uses loader/page context | No immutable request-bound value | Browser currentURI is truthful *current UI state*, not sufficient request provenance across navigation; **D** for exact association |
| Source/top security origin | Internal loader/network parameters | Not supplied | URL parsing cannot reconstruct opaque, sandboxed or inherited origins; **D** |
| Immediate redirect response | Native loader | Optional redirected response | Previous response URI is known; may report that hop; **B** |
| Original URI / stable redirect-chain ID | Internal resource tracking | No chain ID/original-request contract | Cannot join concurrent same-URL requests by timing; do not invent originalURI; **D** |
| Final allow/block decision | Local compiled action | Immediate callback boolean | Public hook could enforce a supplied local decision, but the existing privileged closure is elsewhere; **B/C timing** |

An especially concrete loss occurs in `WebKitWebPage.cpp:313`: its internal
`willSendRequestForFrame` receives **WebFrame& and ResourceLoaderIdentifier**, but
the public signal emits only request and redirected response (:319). Frame
tracking cannot recover an omitted join key. Our extension's `Announce` and
`Message` in `basilisk/components/contentengine/wpe/extension/ContentExtension.cpp`
(:66-77, :184-210) publish opaque frame/document tokens, URLs and isTopFrame; they
are lifetime-safe for script addressing, not network request attribution.

Multiple frames can share a URL/origin; workers and stale documents also issue
requests. Even a currently single-frame registry does not prove a request came
from that document epoch. Previously observed events or arrival order do not
provide the missing identity. Trusted metadata exposed on the actual request
would fix this; better URL heuristics would not.

## 3. Actual sandbox inventory (not inferred from API names)

All **78 JavaScript files** in the extracted tree were byte-compared to the
installed XPI with zero differences. A recursive source search finds:

* **One Cu.Sandbox call:** `frameModule.js:324`.
* **Zero Cu.evalInSandbox calls.** Do not cite a nonexistent call as a blocker.
* Code evaluation uses `Services.scriptloader.loadSubScript`, directly or via
  local alias `lss`.

### Creation contract

`initContentScripts(win,true)`, :311-460:

* Principal argument: **[win]**, a one-element principal-object array. UXP derives
  the content principal from the actual Gecko window (expanded-principal sandbox).
  It is not a system-principal sandbox.
* `sandboxPrototype: win`; `sameZoneAs: win.top`; a name containing URL/title;
  `wantComponents:false`, `wantXHRConstructor:false`.
* `wantXrays` is **omitted**. This tree's `SandboxOptions` defaults it to true
  (`js/xpconnect/src/xpcprivate.h:2903`). WebKit isolation is not the same contract
  as SpiderMonkey Xrays; native DOM wrappers/prototype tampering must be assessed
  if claiming observational equivalence. sameZoneAs is a GC optimization, not a
  required page feature for this caller.
* The return is consumed synchronously as a **persistent global/target object**:
  functions/properties are assigned to it, then it is passed to scriptloader.
  No code here synchronously reads a computed page-DOM result from Sandbox creation.
* For chrome UI, `create` is false and :397 uses the actual chrome window instead.
  That native Gecko branch must remain native.

A project-owned opaque execution-target handle could represent a foreign world
(**B**) without being a DOM object. The existing contentAPI provides execution and
isolation foundations (**A**), but not this target object, host-function binding,
per-extension world ownership, principal mapping or loader queue contract. The
current named world is shared by the privileged API, not a new independent
Cu.Sandbox global for each caller. A handle alone also does not solve the earlier
observer/window acquisition path.

### Every injected binding and its semantics

| Binding / callsite | Role and result use | Service feasibility |
| --- | --- | --- |
| getScriptTagFilters, :332-334 | Host closure returns string/undefined from private filter data | **C** for unchanged immediate lookup; see below. Not a DOM return |
| injectScript, :336-342 | Loads source into same target; return ignored | **A/B** ordered source loading, authorized chrome resource resolution, persistent world |
| injectCSS/removeCSS, :355-369 | USER_SHEET insertion/removal through captured window utils; return ignored | **A/B** CSS facility and URI-to-CSS binding; see completion semantics |
| topContentScript, :373 | Stable is-top boolean for document | **A**, truthful frame state |
| outerShutdown, :382-394 | Removes listeners, replaces functions, clears vAPI, drops messager | **B** world-local disposal plus host subscription release; not DOM access |
| _sandboxId_, :400 | Message route identity | **B** scoped capability-backed identifier; retain document/extension lifetimes |
| sendAsyncMessage, :401 | Host message-sender method | **A/B** JSON transport plus legacy name/sender/principal binding |
| addMessageListener, :403-435 | Receives world-local callback, stores wrappers, subscribes two names | **B** callback IDs/local registry, not function serialization |
| removeMessageListener, :437-458 | Removes stored listener identities and nulls them | **B** subscription and callback lifetime semantics |

The injected functions capture real privileged objects/closures (`Services`, win,
sandbox, messager, scriptTagFilterer). Serializing `function.toString()` cannot
preserve these lexical environments. A new binding service could expose restricted
host operations through capability IDs and keep page-side callbacks local. That
is possible design work, not an existing facility, and cannot expose Components,
arbitrary XPCOM or arbitrary-native-call routing into the content world.

### Every script load and synchronous dependency

| Callsite | Source/target | Return used? | Observable dependency |
| --- | --- | --- | --- |
| frameModule.js:341 | injectScript argument / retained sandbox | No | Later script must share prior global state; source errors/order need defined handling |
| :471 | subscriber script / retained sandbox | No | Invoked by document-ready callback |
| :571 | vapi-client.js / new sandbox | No | Must complete before next script uses its vAPI globals |
| :572 | contentscript.js / same sandbox | No | Depends on prior initialization; enclosing try/catch observes synchronous loader errors |
| js/vapi-client.js:197,202 | calls injected injectScript at requested phase | No | Document-start/end timing and ordered effects, not a returned DOM value |

The *execution purpose* maps to ordered native-world script evaluation (**A/B**).
Returning a Promise where these callers ignore the return is not itself a
problem—but simply scheduling unrelated asynchronous executions loses order,
exception propagation and document-start deadlines. A target queue could preserve
ordering without synchronous DOM IPC; exact immediate try/catch behavior would
not be preserved unless failure is known synchronously or a different service
contract is established. This narrower exception issue is not proof that all
content scripts require synchronous execution results.

Results leave through named serialized async messages and shared world-local vAPI
state. There is no general synchronous page-DOM result channel in these loads.

### Actual synchronous privileged-data path

`frameModule.js:97-100` immediately tests the array returned by sendSyncMessage;
:107-115 immediately returns r[0]. `js/vapi-client.js:103-111` calls the injected
getScriptTagFilters, checks it is a nonempty string and constructs RegExp.
Replacing this return with a Promise changes behavior. This is **C**, *not F*:
only filter strings/data cross the service boundary. A versioned preinstalled
snapshot could make a local synchronous lookup possible (**B** alternative), but
it must preserve invalidation (:139-145, :418-421), document timing and arbitrary
caller semantics. The current JSON API does not supply that snapshot automatically.

The subsequent `beforescriptexecute` cancellation (:112-116) is a **Gecko-specific
content event**, independent of sandbox creation. A generic before-script policy
facility would be **B** if the backend can support it; ordinary DOM event handlers
or a late MutationObserver are not equivalent. This is not a requirement to expose
Gecko DOM objects, nor a proven public WPE interception facility.

CSS also has an ordering caveat: `vapi-client.js:125-147` invokes its completion
callback immediately after insert/remove functions. The current generic CSS
operation returns a Promise. A service mapping must acknowledge actual application
before reporting completion, or explicitly justify weaker observable semantics;
ignored CSS function return values alone do not establish exact compatibility.

## 4. Content window/document uses classified

This table covers the content-bearing integration code. Chrome toolbar/popup/
background DOM remains real Gecko and is not a candidate for foreign emulation.
Standards-DOM work in contentscript/picker/scriptlets should remain local WebKit
DOM work; moving nodes across the bridge is neither needed nor proposed.

| Actual use / callsite | Category | Replacement and qualification |
| --- | --- | --- |
| frameScript.js:21-45 docShell, DOMWindow, window===top | Identity, top-frame test, service acquisition | **A/B** frame ID/isTop + progress subscription. Literal nsIWebProgress.DOMWindow remains **E** if required as a Gecko object |
| frameScript0.js:36-51 win.document, win.frames recursion | Document enumeration / lifetime | **A/B** enumerate document/frame targets and install registrations; must retain matching timing/hierarchy |
| frameModule.js:47-68 window QI→docShell→root→frame manager | Gecko-only service lookup | **B** frame-scoped manager acquisition; no intrinsic need for a DOM pointer. Literal old QI/object path is **E** |
| :229-234 outerWindowID | Identity | **A/B** opaque stable IDs plus legacy numeric mapping if needed; no identity reuse across lifetime |
| :254-258 contentWindow/ownerDocument/defaultView | Request context normalization | **D** needs authoritative request frame; lookup cannot manufacture one |
| :271-291 top/parent identity and location availability | Frame relationship / bookkeeping | **B/D** trusted topology could replace purpose; request association absent |
| :318-320 href/title for sandbox label | URL/display metadata | **A/B** snapshots suffice for diagnostics; not security principals |
| :324-329 window principal/prototype/top zone | Script target, principal, runtime optimization | **B** target/principal service possible; literal native Gecko principal-object/prototype argument is **E** under current Cu implementation |
| :346-348 window-utils feature detection | Gecko-only capability test | **A/B** CSS capability service; literal QI chain is not generic |
| :373 and :579 top identity | Frame relationship | **A** isTopFrame, scoped to document |
| :465-478 readyState, DOMContentLoaded listener, querySelector, event target | Standards DOM and events; immediate control flow | **A/B** run in real WebKit world with local callbacks. Leaving callback in SpiderMonkey and returning actual nodes would be **F**, not necessary to the purpose |
| :481-486 isTrusted, WeakMap(this), listener removal | Event trust, identity/lifetime | **B** local trusted-event handling and opaque endpoint ownership; page-authored JSON cannot assert trust |
| :489-503 opener/top/location chain | Relationship and URL queries | **B/D** requires trusted opener relationships/history; current generic frame list does not expose the complete chain |
| :521-539 popup/opener event registration and manager pairing | Events, relationship, messaging | **B** privileged popup identity/event bridge; no guessed timing association |
| :545-561 doc.defaultView, contentType, location.protocol/host | Metadata and bootstrap eligibility | **A/B** document metadata + engine-local predicate; keep chrome branch native; metadata must exist before injection |
| js/vapi-client.js:99-117 location and script event target.textContent | URL, Gecko event, local DOM/script policy | **A** URL/local DOM; **B** before-script event semantics; **C** preceding filter-string lookup |
| :192-204 window/top, readyState, DOMContentLoaded | Frame/timing | **A/B** native script phase and local real-DOM listener |
| vapi-background.js:1995-2018 load-context associatedWindow/top→docshell→owner | Owning-tab service | **B/D** real XUL browser ID from request-associated view avoids a content window; literal fallback Gecko window chain is **E** |

The shipped source has literal leading unary minus tokens before the querySelector
expressions at frameModule.js:468-469. They coerce the result before `!== null`;
this is not evidence that a meaningful returned DOM node must reach chrome. No
source correction is made. readyState/event ordering and executing the selectors
are still observable operations, but their purpose can stay in the engine.

**No examined purpose intrinsically requires F.** F describes the prohibited
implementation of keeping synchronous DOM-consuming callbacks in SpiderMonkey
while pretending their arguments are remote DOM objects. Likewise standards DOM
is not inherently E. The unresolved transparent-compatibility question is how to
move the relevant computation and bind its closures/services without changing
extension source, not whether WebKit can run a selector or MutationObserver.

## 5. Service-level verdict

| Service | Classification | What is possible, and what is not established |
| --- | --- | --- |
| URI values | **A** | Real UXP URI objects already work for foreign URL strings |
| Existing compiled block rules | **A** | Native engine evaluation before fetch; no privileged JS callback involved |
| Legacy HTTP observer decision | **B + C**, separately **D** | New held-request broker could call existing JS synchronously in browser; public WPE lacks that broker and request attribution. Actual call :2039-2058 |
| shouldLoad bookkeeping | **B + D** | Return at frameModule.js:305 is always ACCEPT; RPC result ignored. Async bookkeeping is plausible only with order/correlation guaranteed before HTTP decision; cannot assume messages race correctly |
| Sandbox as execution target | **B** atop **A** | Persistent opaque target, principal/world ownership, ordered script loading and restricted bindings; not a remote DOM object |
| Sandbox-injected privileged functions | **B**, specific lookup **C** | Capability-bound host operations/local callbacks; no arbitrary closure serialization |
| Named async message manager | **A/B** | Transport exists; add subscription/namespace/principal/sender/lifetime contract, including correct XUL browser target and world-local callback identity |
| Content USER_SHEET helpers | **A/B** | Generic CSS exists; decode/authorize supplied data/chrome resources and preserve ownership/completion order |
| Chrome stylesheet service | **A** native | vapi-background.js:2705-2717 styles real XUL toolbar; never redirect it to WebKit |
| Location/progress service | **A/B** | Generic location/load callbacks exist; legacy registration facade must not claim a foreign DOMWindow or fabricate request/security flags |
| Synchronous script-tag rule data | **C**, possible **B** snapshot alternative | frameModule.js:97,107 and vapi-client.js:103 immediately consume arrays/string; no DOM involved |
| Full unchanged Gecko window/prototype/QI path | **E** literally, often **B** purpose | Replace service acquisition, not simulate Gecko DOM; transparent source-preserving rebinding remains unproved |
| Chrome-hosted synchronous DOM callbacks | **F** if retained across boundary | Move real DOM work engine-local instead; not a fundamental requirement of all content scripts |

A service shim could therefore cover more than the previous report allowed.
An extension-agnostic design would need explicit *execution-target capabilities*,
ordered source installation, restricted host bindings, local callback registries,
principal-aware message routing, and navigation/request lifetime generations.
The current shared isolated world and JSON transport are useful foundations, not
already that full service contract. It must not discover private extension code
by identity or rewrite known filenames.

The remaining network stop remains justified: there is neither an exported
attributed per-request stream at the compiled decision point nor a public pending
request that waits for the privileged filter result. Fixing metadata alone does
not fix timing; enabling synchronous privileged dispatch alone does not create
trustworthy metadata. The content stop should instead be described as **unproved
transparent service rebinding**, with concrete B/C requirements—not an assertion
that use of Cu.Sandbox itself mandates fake DOM or synchronous DOM IPC.

## Investigation limits

This is source-based feasibility, cross-checked against the earlier real server-
counter tests. No new shim/prototype was run, no test result is upgraded, and
unmodified uBlock still fails the existing WebKit acceptance test. No production,
upstream, extension, permission or WebRTC file was modified. A future narrowly
scoped experiment could test ordered target loading and capability-bound async
messages using independent fixture scripts, without claiming to solve the WPE
request-policy or unchanged privileged-bootstrap problem.
