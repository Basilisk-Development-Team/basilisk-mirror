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
