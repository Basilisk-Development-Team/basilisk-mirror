# Phase 3 implementation plan

The current `nsIWebContentView` XPIDL already provides a project-owned C++/XPCOM
boundary with no WPE types. Preserve that interface and the working native host;
do not add a second forwarding vtable for symmetry. The weaknesses are its
backend-owned location, WPE contract/UI names, undocumented observer payloads,
implicit capabilities, and profile discovery inside the WPE storage adapter.

1. Move the interface into `components/contentengine`; put all existing native
   implementation files underneath `contentengine/wpe`. Register the implementation
   by engine identity, not platform identity. Move shared chrome into
   `contentengine` and remove WPE-specific captions/assumptions there.
2. Formalize the existing main-thread reverse observer protocol as project-owned
   events/payloads. Preserve state coalescing and existing lifecycle behavior.
   Introduce generic profile/private configuration consumed by the backend.
3. Add explicit capability discovery, including unsupported permissions and
   private Inspector. Gate generic UI/API behavior by capabilities. Add a
   test-only mock and mechanical boundary audit.
4. Run the complete existing enabled/disabled and lifecycle regression suite
   before implementing additional extension primitives.
5. Audit the installed uBlock Origin 1.16.6.1 source and run an unmodified copy in
   an isolated profile. Trace chrome/UI, browser state, frame scripts, messages,
   stylesheets and Gecko request/content policy dependencies separately.
6. Inspect public WPE request/content-filter APIs. Implement only trustworthy
   generic semantics that can be expressed using those APIs. Do not infer frame
   origins, emulate Gecko channels, patch the extension or modify upstream code.
7. Repeat stress tests with scripts/styles/filter policies active, document exact
   coverage, compatibility limits and future platform requirements.

The backend may use UXP native-widget access to mount its surface; shared chrome
must not manipulate native objects. `mozIDOMWindowProxy` identifies a UXP chrome
host, not a foreign page DOM. A future WKWebView or Windows adapter can implement
this host/content boundary without imitating WPE. Platform detection remains in
configure/backend build files. `--disable-webkit` excludes the optional shim,
backend, registrations and resources exactly as before.

Known origin and Inspector upstream limitations remain feature-local blockers.

## Refactor gate results

Before adding request-filter primitives: enabled build and disabled build passed;
the disabled audit checked 30 ELF files and found no WPE dependencies or optional
components/resources. The mock/boundary audit passed. Existing tests passed: 100
native cycles; 100 reverse mixed-engine cycles; 100 Gecko→WebKit→Gecko cycles with
scripts/CSS and extension active; fixtures A–F and routing; 20 simultaneous views;
20 adoptions; Inspector lifetime; WebProcess termination/recovery; active shutdown;
persistent data, private isolation and mixed session restoration. The pre-existing
platform gitlink difference is untouched.

## Authorized packaging follow-up

After Phase 3, make enabled distributions self-contained for the bundled WPE
runtime: ship its libraries, helpers and resources beneath the application;
use relocatable $ORIGIN-relative lookup; remove build-tree runtime paths; copy
dist/bin elsewhere and launch with no build-tree LD_LIBRARY_PATH; inspect every
shipped ELF with ldd. This must preserve the disabled build's zero-WPE property.
