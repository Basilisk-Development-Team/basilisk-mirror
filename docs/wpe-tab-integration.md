# WPE tab integration

## Inspected boundary and incremental plan

The working native host remains authoritative: WPEPlatform owns its display,
view, SHM frames and subprocesses. A native GTK child clips Gecko's compositor;
explicit frame presentation and post-map allocation are necessary. GTK symbols
outside UXP's NPAPI shim are resolved locally. None of this is replaced.

Basilisk's tabbrowser owns more than content navigation: its browser elements
provide frame-loader lifetime, progress filters, session-store messages, focus
and chrome bookkeeping. `nsIWebNavigation` also exposes Gecko documents and
session history; it cannot honestly represent WPE. An application-local chrome
adapter will expose the small navigation/state contract and retain an empty
Gecko frame loader strictly for existing tab bookkeeping. WPE contentDocument
and contentWindow will be null, never proxies or the empty shell's document.
The shell is an explicit transitional cost, not a Gecko implementation of WPE.

Steps, each independently committed and checked:

1. Preserve the PoC and document its boundaries; keep existing build gates.
2. Extend the content-view interface with engine identity, loading/error state,
   editing, zoom/find and media state using inspected WPE 2.54 APIs.
3. Add an enabled-only browser/content adapter and mixed-tab lifecycle, keeping
   Gecko browser methods untouched. Add small explicit chrome integration hooks
   for operations that currently bypass browser navigation (reload/stop/focus).
4. Add manual engine switching and normal location/title/loading updates.
5. Bridge the platform text clipboard, reuse the existing XUL context popup,
   and route user-initiated new-window requests through Basilisk.
6. Validate mixed tabs, switching, input, close/shutdown and the disabled ELF,
   component and resource audit. Preserve the standalone view as a regression
   harness. Stop at the requested usable mixed-tab milestone before optional
   site routing or advanced extension bridges.

Gecko remains the default, including in enabled builds. The adapter never
claims WebKit TLS state is Gecko security state, and never synchronizes storage,
networking or DOMs. Unsupported privileged permissions remain denied. Downloads,
session restore, cross-window tab adoption, content extension compatibility,
rich clipboard data and other non-core parity must be explicitly tracked rather
than silently implemented through the empty Gecko shell.
