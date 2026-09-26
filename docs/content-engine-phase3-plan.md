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

## Final Phase 3 validation

Enabled and disabled builds pass. The disabled audit again inspected 30 ELF
files with no WebKit/WPE dependencies, optional interfaces, components or chrome.
The mechanical boundary audit and non-rendering mock pass. Regression fixtures
A–F, routing, persistence/private isolation and mixed session restore pass.

Lifecycle results: 100 native create/destroy cycles; 100 WPE→Gecko→WPE cycles;
100 Gecko→WPE→Gecko cycles with installed extension/scripts/CSS; another 100
filtered round trips with scripts/CSS; twenty filtered cross-window adoptions;
twenty simultaneous filtered views; ten Inspector open/close cycles; test-owned
WebProcess kill/recovery with policy enforcement verified after reload; Inspector
owner closure; detach/close during navigation; shutdown with twenty active loads,
filters, Inspector and extension. No test browser helper processes remained.
No sanitizer was run. Native-cycle main-process RSS samples were 343–351 MiB;
this is a bounded smoke check, not proof of leak freedom.

The routing fixture now waits for an HTTP URI before reading its host because
replacement tabs deliberately begin at about:blank until registrations are ready.
The destination-host assertion remains unchanged. Unmodified uBlock was retested:
Gecko blocking/cosmetics pass; WebKit still needs its own portable extension
adapter. The audit records missing events/policies and late shutdown errors.

## Bundled-runtime regression rerun

After rebuilding pristine upstream WPE with relocatable helper lookup, the full
enabled/disabled builds and the complete Phase 3 matrix above passed again with
LD_LIBRARY_PATH unset. This includes 100 native cycles (4,800 notifications),
100 round trips in each engine direction, another 100 filtered round trips,
resource-type distinction, exactly-once script registration after transfer,
20 filtered adoptions, 20 simultaneous views, Inspector/process recovery, active
shutdown, fixtures A–F, routing, persistence/private isolation, mixed restore,
the mock and unmodified uBlock audit. No test-owned helper processes remained.
Native-cycle RSS samples ranged from 314,760 to 323,296 KiB (about 307–316 MiB);
no sanitizer was run. uBlock's expected portable-adapter gap remains unchanged.
See [runtime packaging](wpe-runtime-packaging.md) for copied-distribution and
installer validation.
