# Deferred request policy: upstream API proposal, not implementation

This proposal is separate from the Phase 5 content runtime. No bundled WebKit,
WPE, UXP, or extension code is changed. Names below are illustrative, not APIs
available in WPE 2.54.0. It is useful to any embedder needing live parental,
enterprise, privacy, or extension request policy; it is not an adblock engine.

## Why an application-only broker stops here

Existing compiled content rules block before fetch in WebCore/NetworkProcess.
They execute previously installed rules, not a privileged Basilisk JS closure.
The independent public WebProcess `WebKitWebPage::send-request` signal returns a
boolean synchronously. Keeping its request object alive does not keep the load
pending. `webkit_web_page_send_message_to_view` is asynchronous and cannot supply
that return without adding a blocking RPC/nested loop. Neither is implemented.

The UI process's `resource-load-started` and resource `sent-request` signals lack
an all-resource deferred decision. Navigation `decide-policy` can be held, but
cannot broker script/image/XHR/WebSocket loads. Returning block then replaying a
request would change body, credentials, initiator and lifetime semantics. Returning
allow before a reply would violate pre-fetch blocking. A precompiled approximation
of an arbitrary extension closure is not equivalent either.

Timing and metadata are independent blockers. The public send-request signal
supplies the request URI/method/headers, owning page and optional redirect response.
It supplies no trustworthy request-to-frame/document generation, resource type or
requesting security origin. Current frame enumeration is for script addressing;
there is no public join key connecting it to a network request. URL equality,
currentURI, singleton frames, DOM inspection and arrival order cannot supply one.

## Internal evidence in the bundled pristine source

Paths below are relative to `wpewebkit-2.54.0/Source`.

* `WebKit/WebProcess/InjectedBundle/API/glib/WebKitWebPage.cpp:313-326` receives
  `WebFrame&` and `ResourceLoaderIdentifier`, but emits only request and redirect
  response. The boolean is consumed immediately. This is the precise public
  information-loss boundary for frame/resource attribution.
* `WebCore/loader/cache/CachedResourceLoader.cpp:1258-1274` knows resource type and
  checks compiled content policy before proceeding with the load.
* `WebCore/loader/ResourceLoader.cpp:405-413` can reject redirect continuation with
  an empty request after compiled-policy evaluation.
* `WebKit/WebProcess/Network/WebLoaderStrategy.cpp:401-432` has frame/page and
  parent-frame context; :534-606 assembles source/top origin and navigation context.
  `WebKit/NetworkProcess/NetworkResourceLoadParameters.h` already transports
  security origins and optional parent-frame information internally. This does not
  mean every load has every field, or that those fields are public embedding APIs.
* `WebKit/NetworkProcess/NetworkLoadChecker.cpp:61-71,622-644` retains security
  origins and evaluates content rules for applicable network loads.
* `WebKit/WebProcess/Network/WebSocketChannel.cpp:135-177` separately constructs a
  socket request and sends frame/page identifiers and `clientOrigin()` to the
  NetworkProcess. A resource-loader-only change would not cover sockets.

## Smallest useful public contract

An opt-in UI/embedder-process request-policy signal delivers an immutable request
snapshot and an exactly-once decision object. Initial decisions are allow/block
only. No response-header/header-mutation/redirect parity is implied.

Snapshot fields, each with explicit availability:

* opaque request ID, view ID, document epoch and frame ID; optional parent ID;
* URI, method and loader-derived stable resource classification;
* initiating document URL and actual requesting/top security origins, including
  explicit opaque-origin state (not the string "null" treated as a shared origin);
* navigation/subframe/subresource/worker classification;
* redirect-chain ID, hop index and previous response URI where actually known.

Resource classification should include document, subdocument, script, stylesheet,
image, font, media, fetch/XHR, WebSocket, ping and other. Worker requests must either
carry their real initiator association or explicit unknown/unsupported fields.
No guessed URL-derived classification, origin or frame is acceptable. Fetch vs XHR
may remain one category where the loader cannot reliably distinguish them.

The embedder retains the decision and resolves it asynchronously. WebKit pauses
only the request continuation, not an event-loop thread. Basilisk can then invoke
privileged SpiderMonkey policy on its owning main thread and resolve allow/block.
This browser-local synchronous JS call is not synchronous WebProcess DOM IPC.
The ordinary no-policy fast path remains unchanged.

## Internal plumbing needed upstream

A deferred continuation must precede network fetch, cache delivery/service-worker
handling as specified by the contract, and each redirect continuation. Snapshot
loader-authoritative provenance at creation, before navigation can replace it.
Route a correlation ID and immutable metadata through WebKit-owned asynchronous
IPC to the UI process and return the decision to the owning continuation. Do not
reuse the synchronous public signal by spinning its thread.

The exact interception set needs upstream loader review: cached resources,
non-resource-loader fetches, ping/beacon, workers/service workers, sockets and
redirects do not all share one public interception point. A first API can expose a
precise capability/coverage set, but must not advertise universal interception
until those paths have deterministic tests. Existing security checks (CSP, CORS,
credentials, mixed content, sandbox, service workers) still apply after an allow.

A compatible GTK API could use the same GLib snapshot and decision objects and
shared UIProcess machinery. This proposal requires WebKit IPC/loader changes;
Basilisk's adapter cannot implement them through current public WPE calls.

## Lifetime, cancellation and failures

* One resolution per request/hop; duplicates and stale decisions are ignored.
* Navigation, frame destruction, tab close, renderer/network-process termination
  or embedder teardown cancels affected continuations and informs observers.
* IDs include lifetime/epoch scoping and cannot target later requests.
* Bound outstanding requests and decision time. If mandatory blocking policy is
  registered, timeout/observer failure blocks with an explicit policy error; do
  not silently allow. A different fail-open mode must be an explicit embedder
  policy, never accidental fallback.
* Block must prevent a socket connection or HTTP request from reaching a server,
  not merely discard its response. Local counters should verify every advertised
  resource class, redirects, cancellation and races.
* Private contexts never publish policy metadata into normal-profile persistence.
* Only trusted embedder registrations receive policy data; content messages cannot
  create decisions, forge frame IDs or read extension-private policy state.

## What remains usable now

Compiled generic pre-fetch rules, real isolated content DOM execution, native
script phases, CSS, serialized messaging and browser navigation state remain
usable. Live unmodified Gecko HTTP-observer filtering, complete request logging,
response-header mutation and trustworthy all-request frame attribution are not
provided by this runtime. No upstream patch is included or required for its
content execution features.
