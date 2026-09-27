# Versioned uBlock state adapter — incremental implementation

Explicitly authorized by the user after the effective-state investigation.
This is extension-specific compatibility code **above** the generic engine API.
It is not presented as an extension-agnostic Gecko service. Target: clean uBlock
Origin 1.16.6.1, package SHA-256
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.

## Implemented pieces

`basilisk/base/content/contentengine/adapters/ublock-state.js` provides:

* An immutable, owned snapshot from the **live** extension engine, using the
  extension's own serialization methods. Version/schema/readiness checks reject
  mismatches. Session rules, permanent rules and whitelist are separate.
* `compileStaticNetwork`: decodes the pinned effective filter-class layout into
  generic ordered URL-pattern rules. It handles plain/substr/anchored/hostname,
  wildcard/separator and regular-expression classes, hostname dictionaries,
  pairs/buckets, type/party flags, ordinary exceptions and important blocks.
  The browser does not parse raw EasyList syntax or run a new adblock matcher.
* `pageState`: asks the extension for site enablement and domain-specific
  declarative cosmetic selectors. It uses the extension's URI/domain utilities
  and respects its no-cosmetic-filtering hostname switch. No tab/frame ID is
  supplied to the extension's native CSS injector; returned CSS is applied by
  the generic browser CSS API. It returns procedural data separately and does
  not claim that procedural execution is implemented.

No background object, extension closure, or native DOM object is returned to
page scripts. These entry points are privileged browser-side helpers. The
reader itself is not an authorization boundary; the eventual startup binding
must verify the installed active extension and own its lifetime.

## Tests and what they prove

```
python3 tools/contentengine/ublock/test-state.py <pinned-clean.xpi>
DISPLAY=:92 python3 tools/contentengine/ublock/run-audit.py \
  obj-webkit-enabled <pinned-clean.xpi> --compiled-policy-probe
```

The standalone test runs the **unmodified extension's own** compiler/engine
JavaScript, extracted from the hash-verified XPI, against the adapter. It checks
badfilter removal, selfie restoration, user edits, session/permanent separation,
whitelist changes, immutable ownership and schema rejection. Translated matching
is compared to the real extension engine for a small deterministic corpus,
including host boundaries, URL credentials, exceptions, important rules, type
and party constraints. This is not a complete EasyList equivalence test.

The browser probe installs a clean XPI in a disposable profile. Through its
existing settings API it selects user filters and adds `*/audit-blocked*` plus
a domain cosmetic rule. It reads the resulting live compiled state, translates
it, and installs that output before loading the test page. No manually authored
parallel request-policy rules are used in this probe.

Server counters prove zero blocked script, third-party script, image, stylesheet,
iframe, XHR, fetch, WebSocket and redirect-target requests. Allowed controls load.
The probe also checks static and dynamically inserted cosmetic targets, asks
uBlock to disable/re-enable the site, explicitly refreshes adapter output, and
checks that previously blocked requests reach the server only while disabled.
The same runner keeps its native Gecko control tests.

**This is a test-driven adapter invocation, not automatic installation support.**
The probe explicitly drives state refresh. It does not claim to observe updates
from ordinary extension UI yet. `--require-webkit` still enforces the full
original acceptance conditions and still fails missing page store, logger,
picker and extension-triggered reload integration. Existing acceptance failures
were not removed or made expected.

The adapter is intentionally not yet packaged or loaded automatically. The
fixture stages it only for the probe. No normal browsing behavior is changed by
this partial adapter. The generic URL-pattern API itself is built and tested.

## Remaining rule and integration work

* Domain-constrained compiled class 13 is explicitly reported unsupported, not
  silently widened to a top-page-only approximation. Mixed include/exclude and
  requesting-frame semantics need generic condition support and tests.
* Popup/popunder, inline-script/font, generichide, document strict-blocking and
  other behavioral categories are not ordinary resource blocks. Unsupported
  category entries are reported. Object/plugin classification is not mapped to
  an unrelated resource type.
* Static data-filter/CSP state and redirect-engine state are not translated.
  Blocking a redirect target works; substituting a redirect resource does not.
* Backend-supported regex syntax is narrower than JavaScript regex syntax.
  Unsupported expressions reject compilation transactionally. Exact real-list
  coverage has not yet been measured.
* Dynamic firewall/URL/noop/switch rules are captured, **not translated**.
  `compileStaticNetwork` must not be mistaken for the complete effective policy.
* Backend party classification versus uBlock's requesting-document classification
  needs cross-origin frame tests before claiming semantic equivalence.
* Generic DOM survey, procedural filters, scriptlets, all-frame cosmetics and
  picker execution still need the isolated content runtime integration. CSS
  matching dynamic elements does not prove procedural filtering works.
* Automatic extension discovery/startup/shutdown, coherent update generations,
  pre-navigation installation, session restore and tab/engine lifecycle bindings
  remain to be implemented. Site toggles work only when the probe refreshes state.
* Popup counts, logger entries and page stores are not fabricated. No compiled
  match-event accounting is implemented here.
* Private views still reject the persistent filter-store implementation; no
  private browsing equivalence is claimed.
* Full EasyList browsing, large-list compilation overhead and lifecycle/stress
  acceptance remain outstanding.

The generic backend has no extension identity knowledge. UXP, bundled WPE/WebKit
and the XPI remain unchanged. No deferred request broker is implemented.

## Full-list policy preparation fixes (September 2026)

The reader now merges equal URL/document/party predicates within each precedence
class by their resource masks, retains document unions as one condition, and maps
pure domain exclusions to the generic negated union. Mixed inclusion/exclusion
sets still use the DNS predicate compiler. Fixed-string and hostname classes
already use the supported regular-expression subset; only general/regex classes
need finite-pattern lowering. Cooperative translation steps let chrome yield
between batches. The service discards a result if the extension generation or
owning window lifetime changed while it was preparing.

Popup/popunder, top-document, inline-font/script, data, redirect-replacement and
WebRTC categories do not belong to the ordinary network resource masks. Their
exceptions no longer reject unrelated ordinary network policies. This does not
implement those behavioral features. Generic-hide exceptions are evaluated by
the extension's own matcher for the top document's cosmetic state.

Object/plugin attribution is unavailable. Object blocks remain unsupported;
object exceptions retain their URL/domain/party predicates but conservatively
allow all ordinary resource types. This can underblock those specific predicates
and is explicitly reported as partial coverage. An unsupported ordinary network
exception still rejects preparation rather than silently overblocking.

Effective low/high generic declarative selectors now join domain-specific
selectors, with the extension's exceptions removed. Individual CSS rules prevent
one unsupported selector from invalidating unrelated selectors. This covers
matching dynamically inserted elements, not procedural cosmetics or scriptlets.
Gecko continues using the extension's native content implementation.
