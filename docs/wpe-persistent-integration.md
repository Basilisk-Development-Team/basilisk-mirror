# Persistent WPE integration plan

This phase retains the existing native WPEPlatform host and application-local
content adapter. Gecko stays the default; all WPE additions remain opt-in.

1. Use `WebKitNetworkSession` with explicit `<ProfD>/webkit/data` and `cache`
   paths and the supported persistent-cookie API. Share a session across normal
   windows; private windows share only an ephemeral session, released when the
   last private owner closes. Never open or modify WebKit databases ourselves.
2. Store explicit engine/URI metadata through SessionStore, restoring a real
   WPE view independently of the empty Gecko shell's history. Preserve existing
   tab order/selection/pinning through the existing session machinery.
3. Adapt the existing tab transfer points to recreate foreign views at their
   destination, keeping same-window reordering and Gecko transfer untouched.
4. Audit the actual permission-origin, fullscreen, inspector, frame-script,
   content-policy and stylesheet APIs before implementing their bridges.
5. Add focused extension fixtures, persistence/restart and lifecycle tests;
   validate enabled and dependency-free disabled builds after feature changes.

Inspected sources: `components/sessionstore/{SessionStore,TabState}.jsm`,
`base/content/{tabbrowser.xml,webkit/content-engines.js}`, the existing
`nsIWebContentView`, and the local pristine WPE 2.54 API implementation/headers.

WPE does not export GTK's `webkit_web_view_get_inspector`. Its upstream inspector
implementation creates WPEPlatform views/toplevels, and upstream also supplies
an optional HTTP remote-inspector server. Neither should be replaced by Gecko
DevTools or assumed to provide GTK's embedding API. The existing custom display
must be examined for hosting inspector-created views before implementing this.

## Extension compatibility audit

| Existing surface | Classification | Source evidence / boundary |
| --- | --- | --- |
| XUL menus, toolbars, sidebars, preferences, chrome commands | Works unchanged | These manipulate chrome documents/services, which remain UXP objects. |
| tab selection/order/pinning, currentURI/title, back/forward, mute | Works through browser abstraction | `tabbrowser.xml` and `content-engines.js` retain real tabs and adapt foreign navigation/state only. `browser.contentEngine` is read-only privileged metadata. |
| `loadFrameScript`, message listeners, async messages | Requires extension adaptation for WPE | `nsFrameMessageManager.cpp` loads scripts into Gecko child globals, dispatches structured clones and optionally CPOWs/principals; it is not a portable page-JavaScript loader. Existing Gecko machinery must remain unchanged. |
| Standards-only DOM operations and MutationObserver | Can map cleanly | Execute asynchronously in a WPE isolated world through the public JavaScript API; JSON results/messages only. Gecko can use its existing message manager plus a content-principal sandbox. |
| `nsIStyleSheetService` chrome sheets | Works unchanged | `layout/base/nsStyleSheetService.cpp` registers sheets in Gecko's style system, including chrome. |
| `nsIStyleSheetService` content sheets | Requires extension adaptation | Gecko sheets do not style WPE. WPE's public user-style-sheet manager is the correct corresponding backend. |
| `nsIContentPolicy`, HTTP observers | Fundamentally Gecko-specific as exposed | `nsContentPolicy.cpp` invokes policies with Gecko nodes/principals/types; network observers supply actual Gecko channels. No valid WPE implementation can fabricate those objects. Declarative WPE user-content filters can enforce portable rules separately. |
| `contentDocument`, `contentWindow`, layout/nsIDOM internals | Fundamentally Gecko-specific | WPE getters stay null. A new async bridge cannot make old synchronous callers source-compatible. |
| Gecko DevTools targets and actors | Fundamentally Gecko-specific | They inspect Gecko debugger/DOM objects; WPE must use its own inspector frontend/backend. |

This matrix describes inspected semantics, not blanket compatibility certification
for arbitrary extensions. In particular, the existing WPE bookkeeping shell's
message manager is not a WPE document message manager. Standards-only scripts need
an explicit asynchronous backend bridge, not blind injection of old frame scripts.

## Permission API constraint

The installed public WPE 2.54 camera/microphone/display, geolocation and
notification permission-request types expose allow/deny and (for media) device
categories, but not the requesting frame's security origin. The inspected
implementations retain private request proxies; those are not embedding APIs.
`WebKitPermissionStateQuery` exposes an origin for a *state query*, not an
unambiguous identity for a later permission request. Associating requests with
the last query or the top-level URL would misattribute cross-origin frames.

These permissions must remain denied until their actual requesting origin can
be supplied through a supported API. Do not display a top-level origin as though
it were the requester. A minimal upstream improvement would expose the request's
security origin on the public permission-request types; such an addition belongs
upstream, not in a private Basilisk WebKit patch. No WebKit source modification
has been made.

The concrete upstream media implementation confirms the gap:
`Source/WebKit/UIProcess/API/glib/WebKitUserMediaPermissionRequest.cpp`,
`webkitUserMediaPermissionRequestCreate` (around line 211), receives both
`userMediaDocumentOrigin` and `topLevelDocumentOrigin`, then explicitly marks
both unused beneath `FIXME: store SecurityOrigins`. The public request interface
only supplies allow/deny; media subclasses add device-category queries. A
Basilisk adapter cannot recover the discarded requesting identity reliably.

This was the stopping point of the preceding phase. The subsequent authorized
continuation leaves these requests denied and implements independent features;
see [wpe-content-bridge.md](wpe-content-bridge.md). The smallest plausible upstream change is to retain those
origins and expose read-only security-origin accessors (with corresponding
origin support on the other relevant request types). This is a generally useful
embedding API improvement and a candidate for upstream submission. Alternatives
considered: using the displayed page origin (unsafe for subframes), matching a
preceding permission-state query (not a request identity), injecting wrappers
into page APIs (not authoritative and not complete), or continuing to deny the
unsupported requests (the current safe behavior). No private native pointer or
upstream patch has been introduced.

## Completed and validated before this stop

* Profile-owned WPE persistent cookies, localStorage and IndexedDB survive two
  distinct browser processes using one profile. Gecko storage remains separate.
* Normal windows share a session. Private windows cannot read normal data;
  closing/reopening the last private window loses its private cookies/storage.
* SessionStore extData explicitly records engine, URI, title, zoom and mute.
  Mixed-tab serialized restoration preserves ordering, selection and pinning.
  Full WPE back/forward-history serialization is not yet implemented.
* Existing adoption/detach entry points restore WPE metadata into a new native
  view instead of swapping its bookkeeping docshell. Twenty cross-window
  transfers and detach passed. Same-window movement passed; drag images now use
  the tab instead of attempting Gecko canvas capture of a foreign surface.
* Enabled and disabled builds passed. The disabled audit checked 30 ELF files,
  resource packaging, interfaces and component registration with no WPE result.

Run the restart/private/adoption fixture with an isolated X display:

```
DISPLAY=:91 LD_LIBRARY_PATH="$PWD/build-wpe-deps/prefix/lib64" \
  python3 tools/wpe/run-persistence.py obj-webkit-enabled
```

This fixture performs serialized SessionStore restoration across a real restart;
it does not yet exercise every automatic startup/crash-recovery policy. The
100-cycle/20-tab stress matrix, developer tools, script bridge, blocker rules,
per-site routing and the requested test-extension suite remain unfinished. The
extension matrix above is a source audit, not a claim those bridges exist.
