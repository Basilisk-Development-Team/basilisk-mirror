# Phase 4: legacy extension compatibility boundary

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
