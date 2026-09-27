# Deferred request policy: implementation scope review

Baseline: Basilisk `c0f9bab`; WPE 2.54.0 release archive pinned in
`third_party/webkit/upstream.json`. Platform gitlink remains
`f865b384ebe9a86d17e0f015482d8b5d7bb283bc`; the pre-existing platform checkout is
`845e0e1a2ffd48d33a48ca89fa72acc61399395b`, with a clean platform working tree.

The newly authorized downstream-patch policy removes the previous prohibition on
adding a WPE API. **Current public API insufficiency is no longer the stop reason.**
This review scopes the internal lifetime work before implementing a runtime patch.
No new WPE API, broker, observer adapter or transparent content loader is implemented
by this review. The series is empty, and the running browser is unchanged.

## New source findings

Paths are relative to `wpewebkit-2.54.0/Source`.

1. A NetworkProcess broker is viable in principle without putting SpiderMonkey
   in a WebProcess or adding synchronous DOM IPC. The browser can receive an
   asynchronous WebKit message, run its own JS locally and reply asynchronously.
2. `WebKit/NetworkProcess/NetworkResourceLoader.cpp:227-280` has `start` and
   `startRequest`; policy can precede network/cache work. However, the usual async
   entry is `startWithServiceWorker` at :2188, reached by
   `NetworkConnectionToWebProcess.cpp:663`. A hook only in `startRequest` would
   miss service-worker handling before its fallback.
3. Synchronous XHR uses a different entry:
   `NetworkConnectionToWebProcess.cpp:680-692` constructs a synchronous loader and
   calls `start`. A new asynchronous NetworkProcess policy can defer its existing
   reply without spinning a WebProcess event loop, but cancellation must finish
   that reply. Its existing destructor asserts that no synchronous reply remains.
4. Redirects already have deferred continuations:
   `NetworkResourceLoader.cpp:1330-1500` and
   `WebProcess/Network/WebResourceLoader.cpp:124-153`. The new decision belongs
   before the redirected request resumes; deferring the old synchronous GLib
   `send-request` signal is neither necessary nor correct.
5. Metadata is better than the old public hook exposes. Existing
   `Shared/ResourceLoadInfo.h` includes a resource-load ID, frame/parent IDs,
   document UUID, original URI/method and loader-derived type. The mapping in
   `NetworkResourceLoader.cpp:507-587` distinguishes XHR/fetch/ping/beacon via
   `ResourceRequestRequester` and other classes via `FetchOptions::Destination`.
   No extension/URL-based classification is needed for these loads.
6. `NetworkResourceLoadParameters.h` also contains actual source/top security
   origins, document URL, main-frame-navigation status and loader context. These
   can be serialized with explicit missing/opaque states. They must not be replaced
   by the current UI URL or reconstructed from URL equality.
7. WebSockets are **not NetworkResourceLoader loads**. In
   `NetworkConnectionToWebProcess.cpp:545-553`, creation immediately constructs
   `NetworkSocketChannel`; its constructor (`NetworkSocketChannel.cpp:55-77`)
   creates/resumes the network task. The existing channel assumes a socket exists.
8. Merely postponing that creation is unsafe. WebProcess disconnect sends a
   channel `Close` message (`WebSocketChannel.cpp:282-293`). NetworkProcess dispatch
   (`NetworkConnectionToWebProcess.cpp:297-310`) ignores channel messages when the
   ID is absent from `m_networkSocketChannels`. If creation is deferred outside
   that registry, an early close is lost and a later allow can create an orphan
   connection. A registered pending state or equivalent cancellation receiver is
   required before emitting the policy request.
9. Ordinary loader teardown is also more than retaining a callback. `cleanup`
   (:590-625) removes the loader from its connection; `abort` (:650-683) handles
   keepalive, worker tasks, network cancellation and synchronous completion.
   Deferred policy must be revoked at these boundaries. A captured strong loader
   alone can outlive cancellation and incorrectly resume later.

These are source findings, not successful runtime tests of a new broker.

## Smallest defensible design to implement

Use a NetworkProcess-owned pending decision, UIProcess public decision object and
WebKit asynchronous request/reply IPC. The resource retains its continuation;
the UI retains only a scoped decision capability and immutable metadata.

```mermaid
sequenceDiagram
  participant L as Network resource / socket lifecycle
  participant U as UIProcess WPE API
  participant B as Generic browser request policy
  L->>L: Register pending decision and deadline
  L->>U: Request ID, epoch, authoritative metadata
  U->>B: Generic request event
  B-->>U: Allow / block asynchronously
  U-->>L: Resolve request ID + epoch
  L->>L: Validate still pending; resume or cancel once
  Note over L,U: Cancellation/timeout revokes the decision; late replies do nothing
```

* Opt-in per view, default off. Propagate through existing page preference/creation
  IPC and request parameters. No callback round trip for embedders not opting in.
  Restore the flag correctly after process replacement; do not silently turn policy
  off after a NetworkProcess crash.
* New GLib `WebKitResourceRequestDecision` (provisional name), immutable snapshot,
  allow/block completion and cancellation notification. Do not reuse the existing
  navigation decision's default `use()` on disposal: mandatory resource policy must
  not fail open when a listener disappears.
* Metadata: current URI/method, original URI where known, opaque request/redirect
  chain identity, loader type, frame/parent/document identifiers, source/top origin
  with opaque/missing flags, main-resource/main-frame status and redirect hop.
  Reuse existing internal types/serializers; expose stable public values, no pointers.
* Proposed deadline: 30 seconds per hop, enforced in the owning network lifecycle.
  Timeout, dropped handler, embedder destruction or lost connection blocks with an
  explicit policy/cancellation error. No requests left pending forever.
* Cancellation removes pending state and prevents a later allow from recreating a
  loader/channel. Pending socket close must be routed before any network task exists.
  Existing synchronous XHR reply must resolve on cancellation; no new synchronous
  call into extension JS or a WebProcess DOM.
* Cache/service-worker semantics must be explicit. NetworkProcess loads can be
  held before cache/worker dispatch. WebCore memory-cache reuse does not necessarily
  create such a load; a network broker must not advertise interception of every
  in-memory resource consumption. Worker/background loads with missing ownership
  must have explicit availability/coverage, not guessed frame/origin fields.

## Reviewable patch split and expected files

This is a **multi-part shared loader change**, not just a new getter/signal on the
existing WPE callback. The full requested HTTP + socket + cancellation coverage
exceeds the small public-API-layer patch initially contemplated. This is the point
where the user's instruction to report expanded scope before implementation applies.

1. **HTTP resource lifecycle, attribution and UI API.** Expected changes include
   `NetworkResourceLoader.{h,cpp}`, `NetworkResourceLoadParameters.{h,serialization.in}`,
   `NetworkConnectionToWebProcess.cpp`, `WebLoaderStrategy.cpp`, page preference
   plumbing, new shared snapshot serialization, `NetworkProcessProxy.{h,cpp,messages.in}`,
   `WebPageProxy.{h,cpp}`, GLib decision/view API files and WPE API build/header lists.
   Initial, sync-XHR, worker fallback and redirect paths must share cancellation
   semantics without double-dispatching policy.
2. **WebSocket pending lifecycle.** Changes in `NetworkSocketChannel.{h,cpp}`,
   connection/channel dispatch, `WebSocketChannel.cpp` and its creation IPC metadata.
   Preserve a cancellable registered channel while no socket task exists. No
   handshake/server connection until allow. Propagate available frame/client-origin
   attribution; unavailable parent/document data remains explicitly unavailable.
3. **Tests and browser adapter, separate changes.** GLib API/lifecycle tests,
   deterministic held-request counters and cancellation/timeout tests first.
   Then Basilisk generic capability, request representation and asynchronous
   resolver; WPE native decision objects never leave the backend adapter.

No UXP, Gecko, Necko or SpiderMonkey modification is part of this design. No
WebCore/JSC architectural rewrite is proposed. The significant expansion is shared
WebKit loader/socket lifetime and IPC work, rather than application-specific logic.
A first HTTP-only patch is smaller, but cannot satisfy or advertise WebSocket
coverage; splitting patches does not make that missing behavior disappear.

## Validation required before any success claim

* Native embedding tests: default-off behavior; delayed allow; delayed block;
  unhandled/dropped/timeout decision; duplicate/late resolution; cancellation before
  decision; redirect hop; sync XHR cancellation; socket close while pending.
* Server counters sampled **while held** and after resolution: script/image/style/
  iframe/XHR/fetch/socket/redirect target must have zero arrivals until allow and
  remain zero on block. Allowed controls must load.
* Frame/origin metadata: same-URL sibling frames, nested cross-origin frames,
  opaque/sandboxed origins, navigation replacement, worker/unknown contexts.
* Process/window/tab destruction and re-creation, private contexts, 100 switching
  cycles, no inherited policy after owner destruction, no orphan socket/helper.
* Only then call unmodified privileged extension observers through truthful
  compatibility contracts and repeat counters with **no compiled rule fallback**.
* Gecko controls, disabled-build dependency audit, relocated runtime and source-
  series verification remain separate required checks.

## Transparent content and legacy-observer work are still separate

The unmodified XPI remains 1.16.6.1 with SHA-256
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.

The HTTP observer at `js/vapi-background.js:2134` uses a real `instanceof
Ci.nsIHttpChannel` gate. Its decision path needs URI, loadInfo classification/frame
identity, a load-context `topFrameElement` (the actual XUL browser), and cancel.
A real nsIURI and real XUL browser are available; no foreign DOM is needed for
those purposes. Redirect/header operations remain separate unsupported contracts.
Any interface claim must be reviewed against its actual semantics; a successful
broker alone does not justify pretending to have a complete Necko channel.

Content still enters through `frameModule.js:544-572`: a native document supplies
`defaultView`, which is passed through docshell/message-manager acquisition at
:47-68 and native `Cu.Sandbox` at :324. Subsequent host functions capture privileged
state (:332-458). The completed opt-in runtime represents many purposes, but native
service references do not automatically redirect to it. No general transparent
rebinding mechanism has yet been demonstrated. Copying function text drops captured
state; manufacturing a foreign document/window would violate the boundary.

Thus this report does not announce either unmodified-uBlock network success or
content bootstrap success. No source patch to that extension, UXP or WPE has been
made while preparing this scope review.

## Work completed during this review

* `third_party/webkit/upstream.json` and ordered `patches/series` established.
* Read-only source verifier compares pinned archive + series against every source
  entry, with focused tests for order, additions/deletions, edits, mode/symlink
  changes, missing/extra files, archive checksum and unsafe paths.
* WPE build wrapper now verifies that invariant before build/install and redirects
  generated Python caches to the object directory.
* Real-tree check: 38,842 source entries match the pinned release, zero patches.
* Nine verifier tests pass. No new broker build/runtime/acceptance test is claimed.
