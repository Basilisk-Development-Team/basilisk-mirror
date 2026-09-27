# Daily-use policy integration requirements

The approved versioned adapter remains above the generic content engine API.
No UXP, upstream WPE/WebKit or extension source changes are authorized.

uBlock's compiled FilterOrigin class (13) represents `$domain=`/`$from=`
constraints on the requesting document hostname. A top-page URL constraint is
not equivalent for cross-origin frames. The generic rule interface exposes
an explicitly named `documentURLPattern` with an optional negation, mapped to
the backend's supported requesting-document URL condition. Opaque/about:blank
contexts must not be assigned an invented origin.

The pinned backend's ContentExtensionsBackend.cpp:269 uses the actual current
Document URL for frameURL (or the resource URL when no current Document exists).
This is URL attribution, not a SecurityOrigin API. Consequently inherited-origin
about:blank/srcdoc and document-navigation edge cases require separate tests and
must not be advertised as origin parity. ContentExtensionParser.cpp permits one
condition kind per trigger. Combining top-document and requesting-document
conditions is not silently approximated. The project-owned domain predicate
compiler expresses mixed included/excluded DNS suffix sets as equivalent positive
URL patterns. It does not infer opaque or inherited origins.

Policy preparation for a top-level response can use the public deferred
navigation response decision already provided by the backend. It must happen
before releasing the new document for subresource loading. This is a bounded
navigation lifecycle operation; it is not a per-resource privileged-JS broker.

## Automatic lifecycle (in progress)

`LegacyBlockingExtensions.jsm` discovers active bootstrap extensions through
AddonManager. Recognition and effective-state serialization live in the explicit,
versioned adapter, not in the generic content engine. Discovery does not hardcode
an extension ID. The supported adapter currently recognizes uBlock 1.16.6.1.

Addon lifecycle notifications and a shared 500 ms timer detect state changes.
The timer compares engine identity, counters, site state, settings, and dynamic
rule snapshots; the expensive static snapshot/translation runs only on change.
This is polling, not an extension-provided rule-export notification. An epoch
invalidates discovery callbacks after disable or the last window unsubscribe.

`engine-blocking.js` serializes policy/CSS replacement per alternate view.
Chrome navigation awaits preparation; backend-originated navigation holds the
existing public top-document response policy decision for at most 30 seconds.
Timeout denies that document response. Stop, replacement navigation, process
termination and destruction cancel the decision. This gate currently covers GET
main-document responses, not arbitrary requests or form submission semantics.

Application-owned policies and CSS are deliberately not copied into session or
view-transfer registration state. The provider supplies current state to each
new view. Gecko keeps its existing extension implementation.

## Validation on the webkit branch

* `test-blocking-lifecycle.js`: discovery cancellation, disable invalidation,
  and 100 close/re-subscribe transitions pass with mocked AddonManager timing.
* `test-policy-compilers.js` and the pinned XPI state tests pass.
* The native network suite passes mixed-origin requesting-document inclusion
  and exclusion, existing pre-fetch counters, policy isolation, failed-update
  rollback, and independent Gecko behavior.
* `navigation-policy` passes deferred parsing, allow/block, stop, replacement,
  timeout, WebProcess termination, recovery and tab destruction. The main HTML
  response reaches the server before this gate; subresources do not fetch while
  it is pending. This is distinct from engine-local resource filtering.
* Automatic unmodified-XPI audit: all nine blocked-resource counters are zero;
  allowed controls load; declarative and dynamically inserted cosmetic targets
  are hidden; site disable/re-enable restores/removes requests; popup current
  site and extension reload work. No harness adapter refresh is used.
* The strict audit still **fails** request logger and picker assertions. Those
  checks remain enabled. No blocked-request count is fabricated.

## Remaining daily-use gaps

This integration is not yet the completed daily-use milestone. Private compiled
policy storage, the full lifecycle/stress matrix, procedural/generic cosmetics,
dynamic-rule enforcement, picker and logger coverage remain incomplete.

A full EasyList snapshot downloaded from its configured primary URL on
2026-09-26 has SHA256
`316c20c7172349860cf4f07a46e7711a8396f7553e7eb0a363b24c8acf9ada77`.
The pinned extension parser accepted 61,453 network entries (36 discarded).
Translation produced 169,732 rules, exceeding the generic 100,000-rule limit
and the backend's 150,000-rule limit. Consequently this is **not** a successful
full-list installation. Unsupported output includes bounded regex quantifiers,
object requests, popup behavior, top-document behavior and generic-hide
exceptions. Behavioral/cosmetic exceptions must be distinguished from ordinary
network exceptions before safely expanding coverage. Currently unsupported
exceptions reject preparation rather than silently applying an overblocking
policy. A normal full-list installation can therefore fail navigation; the
controlled user-filter acceptance result must not be called daily-use readiness.

Backend party classification uses the top document's registrable domain. It is
not equivalent to uBlock's requesting-frame classification for cross-origin
frames. Domain-conditioned URL support must not obscure that separate limit.

The full-list translation diagnostic is reproducible with:

```
python3 tools/contentengine/ublock/test-state.py /path/to/clean.xpi /path/to/easylist.txt
```

It exercises the extension's own parser and effective-state serializer, not a
new filter-list parser, and does not claim native installation or server-side
blocking validation for that full list.
