# Phase 4: legacy extension compatibility boundary

See the [service-semantics reassessment](service-semantics.md) for a correction to
the overly broad Sandbox/window conclusion below. It separates representable
service purposes from unchanged-callsite constraints, and timing from metadata.

This investigation starts from commit 09efebd. WebRTC, permissions, Gecko/UXP and
upstream WebKit are outside its modification scope. The target is the clean
installed uBlock Origin 1.16.6.1 XPI with SHA-256
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.

The [member matrix](member-matrix.json) lists source-confirmed integration members,
their callers and whether generic equivalents exist. Source references are inside
that XPI. Optional/fallback code is not claimed to execute in every runtime test.
The earlier [functional audit](../content-engine-ublock-audit.md) remains relevant.

## Critical path, before introducing compatibility objects

1. `frameModule.js:shouldLoad` obtains context through real DOM windows, docshells
   and window utils. It sends frame/type/URL bookkeeping synchronously and returns
   `ACCEPT` unconditionally. It does **not** make uBlock's final block decision.
2. `vapi-background.js:httpObserver.observe` rejects a subject unless
   `subject instanceof Ci.nsIHttpChannel`. It reads URI, loadInfo resource/frame
   IDs and load context, then invokes its existing filter callback. The result
   calls `cancel`, or `redirectTo` with a changed redirection limit. Response
   processing reads content length/CSP and can cancel or change CSP headers.
3. The current generic filter API installs declarative URL/type/party rules into
   the engine. It has **no per-request callback**, attributed RequestInfo stream,
   or suspended-request token to send into this privileged filter callback.
4. The public WPE `WebKitWebPage::send-request` hook runs in the **WebProcess**.
   It supplies page, URI request and optional redirected response; its return
   value synchronously allows/cancels the request. It lacks requesting frame,
   parent identity, security origins and resource classification. The page URI
   is not a substitute. `webkit_web_page_send_message_to_view` is asynchronous;
   there is no public request-suspension/resume operation to await the browser's
   existing extension engine. Returning allow then cancelling later is not
   pre-fetch enforcement. Returning block then replaying changes request/body/
   credentials/cache/redirect semantics and is not an acceptable substitute.
5. The content entry scripts are also not portable frame scripts: `frameScript`
   reads `docShell`/`DOMWindow`, imports a privileged module and installs a Gecko
   progress listener; `frameScript0` hands real documents to that module; the
   module constructs `Cu.Sandbox([win], {sandboxPrototype:win,...})` and calls
   `loadSubScript` against it. Its stylesheet callbacks capture real window-utils.
   Synchronous script-tag filter lookup immediately consumes a returned array.

A project-owned URI object is not a problem: `Services.io.newURI` already provides
real nsIURI semantics for a foreign URL, and the browser's currentURI already uses
it. Adding another URI parser/wrapper would not connect any missing hook.
Likewise request-local property bags or async message facades can be represented,
but cannot manufacture the missing attributed request or port the unchanged
privileged sandbox loader. No new legacy QI interface is advertised in this work.

## Stop boundary

Network callback compatibility stops at the missing attributed, deferrable
pre-fetch backend hook. Chrome-side use of the extension's existing filter engine
cannot be implemented by wrapping the current declarative-rule API. Parsing its
filter lists in Basilisk, copying its engine into page JavaScript, synchronously
waiting on WebProcess messages, or identifying its private callback by extension
identity would contradict this task.

Transparent content bootstrap stops at its actual Gecko DOM/sandbox dependency.
Providing `document` in the real WebKit world is possible; passing that same
object to the existing synchronous privileged Gecko observer/Sandbox is not.
A script-specific rewrite or bypass directly calling discovered private content
files would be extension-specific behavior. A generic asynchronous message facade
alone does not cause the unchanged bootstrap to use it.

No guessed frame IDs/origins, forged nsIHttpChannel subjects, proxy documents,
Components in WebKit, or uBlock identity branch is added. These stop conditions
are capability-specific, not a claim that every possible standalone compatibility
utility is impossible. Existing portable scripts/styles/messages and declarative
blocking remain available and unchanged.

## Smallest upstream request facility needed

An upstream-supported asynchronous pre-fetch policy decision at an embedder
boundary must retain the request until allow/block arrives. Its immutable metadata
must include a stable request ID/lifetime, actual frame and parent IDs, resource
class, source/top security origins with explicit opaque/unknown states, HTTP method,
and redirect relationship where known. Cancellation on view/process teardown must
resolve every outstanding decision. Internal loader state already carries origins,
document URL and frame/navigation information in `WebLoaderStrategy.cpp`; none of
that makes it available through the public signal.

This would benefit other embedders with a privileged policy engine and avoid
synchronous IPC or guessed attribution. It is a proposed API direction, not an
implemented upstream patch. Metadata alone would not solve the current immediate
callback timing, nor would it port the extension's Gecko sandbox bootstrap.

## Validation plan

Expand the clean-XPI local server matrix to cover stylesheets, frames, first/third
party controls, WebSockets and redirects in addition to script/image/XHR/fetch.
Keep an explicit strict acceptance mode: it must fail when WebKit requests reach
the server, even if an audit completed successfully. Rerun generic filtering and
extension fixtures as independent controls. Do not call those independent passes
unmodified-uBlock compatibility.


## Public hook alternatives checked

* `WebKitURIRequest.h.in` exposes URI, HTTP method and request headers. Those
  facts can be truthfully copied; the request method was not actually consumed
  by this uBlock version's HTTP observer. `originalURI`, URI `port` and `prePath`
  likewise are not requirements of this observed request path. URI parsing
  support must not be mistaken for request ownership/attribution support.
* `WebKitWebResource::sent-request` explicitly runs **after sending**; it cannot
  implement pre-fetch cancellation. `resource-load-started` is an observation
  signal without a general suspend/decision handle.
* `WebKitWebView::decide-policy` covers navigation/new-window/response decisions;
  it is not an equivalent cancellable callback for every script/image/XHR/socket.
* The WebProcess `send-request` signal allows request URI/header mutation and
  immediate cancellation. A narrow URL-only policy there is possible, but would
  neither expose missing origin/frame/type facts nor execute the existing
  privileged uBlock closure. Moving/copying that engine would introduce different
  extension state and privileged execution, not preserve legacy API semantics.

## Resource contract comparison

| Generic class | Legacy numeric type consumed by this version | Boundary |
| --- | --- | --- |
| topDocument / subdocument | 6 / 7 | Declarative matching only; no live attributed callback |
| document | Both 6 and 7 | Must distinguish before invoking legacy callback |
| script / image / stylesheet | 2 / 3 (also 21) / 4 | Declarative matching exists |
| font / media | 14 / 15 | Declarative matching exists |
| fetch | 11 and 20 | Generic class covers XHR and fetch; does not invent a distinction |
| websocket | 16 | Declarative pre-fetch test passes; HTTP-to-WS normalization belongs to existing extension path |
| ping | 10 / beacon 19 | Mapping needs actual backend classification, not URL guessing |
| other | 1 | Unknown is not evidence of a specific resource class |
| object/plugin | 5 / 12 | No separate alternate plugin capability; NPAPI stays Gecko |
| CSP report | 17 | No separate generic class currently exposed |

The numeric table describes extension source, not events currently emitted by a
compatibility layer. Frame IDs available to generic content scripts cannot be
assigned to a network request merely because its URL resembles a document URL.
First/third-party inputs used by uBlock depend on correct tab/frame tracking;
the generic declarative main-document party predicate is not a replacement.

## Functional categories and decision

| Area | Existing truthful facility | Remaining unchanged-extension dependency |
| --- | --- | --- |
| Startup/chrome UI | Native hidden/windowless Gecko chrome and XUL | None related to selected engine |
| Tabs/current site | Real XUL browser, nsIURI, title and selection | Location listener initialization still needs Gecko DOMWindow |
| Network block/classification/redirect | Compiled generic URL/resource rules | Attributed immediate channel callback into existing filter engine |
| First/third party/frame context | Actual document URLs and opaque content frame IDs | No safe correlation to public per-request metadata |
| Cosmetics/procedural scripts | Real isolated DOM, CSS and MutationObserver | Privileged Gecko document observer and Sandbox bootstrap |
| Messages | Generic async serialized exchange | Existing frame-script import/loader plus synchronous lookups |
| Picker/zapper | Portable page execution can implement interactions | Legacy injectScript message reaches native bookkeeping frame manager |
| Logger/statistics | No accurate per-request generic observation today | Native channel-derived filter events/page stores absent |
| Per-site policy/filter updates | Existing extension engine and native storage | It receives no alternate request events and exports no declarative rules |
| Reload | Generic browser.reload works | Extension explicitly uses native browser.webNavigation.reload |

An async facade for explicitly portable scripts is possible future adapter work.
It does not automatically port these entry scripts. Building unused facade classes
and declaring success would conceal the unchanged call graph. No production shim
was installed, so Gecko traffic remains completely native and there are no new
request adapters whose lifetime, principal or QI semantics could be mistaken for
implemented behavior. No compatibility-overhead benchmark is claimed: there is
no new dispatch path to measure. Existing generic filter overhead is unchanged.


## Expanded clean-XPI acceptance results

The runner copies the original XPI into a fresh profile, records version/hash,
and verifies both original and installed-copy hashes after the run. It only sets
local test filters through the existing extension settings API. No extension
source or in-memory hook is replaced. Host platform milestone is 6.9.0; the
extension's source `modernFirefox > 44` branch is therefore false, consistent
with the observed legacy `shouldLoad` messages.

The new `--require-webkit` mode returns failure when the measured WebKit acceptance
probes fail. Ordinary audit completion does not mean extension compatibility.

| Probe | Native Gecko control | Unmodified uBlock on WebKit |
| --- | --- | --- |
| First-party blocked script | 0 server requests | 1 request |
| Third-party blocked script (`localhost` vs `127.0.0.1`) | 0 | 1 |
| Blocked image / stylesheet / iframe | 0 each | 1 each |
| Blocked XHR / fetch | 0 each | 1 each |
| Blocked WebSocket upgrade | 0 | 1 |
| Blocked redirect target | 0 | 1 |
| Allowed controls of the same classes | Arrive/load | Arrive/load |
| Static and dynamically inserted cosmetic target | Hidden | Visible |
| Page store and location/policy messages | Correct | Absent |
| Logger for test-engine request URLs | Entries present | 0 |
| Element picker iframe added | 1 | 0 |
| Extension reload changes page count | 1 to 2 | Remains 1 |
| Per-site disable then enable | Allows then blocks/hides again | Ineffective |
| Extension storage / dashboard | Pass | Same native chrome/storage works |
| Popup | Existing automation closes before sampling | Opens with page title, but lacks correct filtering data |

These counts are sampled before the per-site toggle deliberately allows requests.
WebSocket fixtures perform a real HTTP upgrade and close handshake; a missing
rendered element is not used as evidence of network blocking. The picker result
only measures actual injection, not full user interaction or a zapper workflow.
The strict mode also checks page-store/reload/logger/toggle/picker results. It does
not pretend to cover all 26 acceptance criteria when the foundation already fails.

Independent controls rerun in this phase:

* Generic server-counter filtering: pass for script/image/stylesheet/subframe/
  XHR/fetch/WebSocket/redirect targets, party constraints, policy toggle and
  independent Gecko behavior.
* Existing extension fixtures A–F and routing/manual override: pass.
* Generic boundary scan: pass.
* Disabled build dependency/component/interface/resource audit: pass, 30 ELF files.

There are no production-source/build changes in this phase, so no new enabled or
disabled binary build is claimed. WebRTC/permissions, upstream sources and UXP are
untouched. No production extension-identity conditions were added. No mock request
adapter, stress/performance benchmark, or security guarantee for an unimplemented
legacy dispatch path is claimed.

Reproduce the failing primary acceptance test:

```sh
DISPLAY=:91 python3 tools/contentengine/ublock/run-audit.py obj-webkit-enabled \
  /path/to/unmodified/uBlock0@raymondhill.net.xpi --require-webkit
```

Evidence logs from this run: `/tmp/basilisk-phase4-ublock-final.log`,
`/tmp/basilisk-phase4-generic-network.log`,
`/tmp/basilisk-phase4-extension-regression.log` and
`/tmp/basilisk-phase4-disabled-audit.log`. They are generated artifacts, not committed
build products. The machine-readable member matrix and expanded fixture are
committed independently. **Phase 4's functional objective is not achieved.**
The requested stop conditions have been reached for live request dispatch and
transparent Gecko content bootstrap; no misleading compatibility objects were
installed to conceal those missing semantics.
