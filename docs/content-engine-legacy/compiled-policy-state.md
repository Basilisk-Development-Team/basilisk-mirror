> Historical investigation: the uBlock-specific adapter described here has been removed. See [replacement status](ublock-adapter.md). These results do not validate the new extension runtime.

# Engine-local filtering: effective-state acquisition

Scope: use the existing compiled request-policy backend. The deferred request
broker is not part of this work. This report distinguishes acquiring extension
state from compiling/enforcing a policy; successful enforcement does not solve
state acquisition automatically.

Target is the unmodified uBlock Origin 1.16.6.1 XPI, SHA-256
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.
Extension paths below refer to that package, not browser implementation files.

## Where effective state changes

| Change | Actual extension path | What crosses a browser service boundary |
| --- | --- | --- |
| List load/reload | `js/storage.js:646` `loadFilterLists`, `:680` apply, `:662` freeze | Storage writes list metadata; `staticFilteringDataChanged` broadcasts list keys and cosmetic settings, **not rules** |
| User filter append | `js/storage.js:434` `onSaved` | Private compile/apply/freeze; storage updates counts; invalidates selfie |
| Startup from cache | `js/storage.js:1103` selfie load | Private version-checked cache, restored by extension-specific `fromSelfie` methods |
| Site disable/enable | `js/ublock.js:111` `toggleNetFilteringSwitch`; `js/storage.js:228` `saveWhitelist` | Stores extension-specific whitelist directives; changes private modification time |
| Temporary dynamic rules | `js/ublock.js:422` `toggleFirewallRule`; `js/messaging.js:975` `modifyRuleset` | Mutates session firewall/switch/URL-filter objects; persistence is optional |
| Permanent dynamic rules | `js/storage.js:204-223` | Stores extension-specific rule strings; these are not the complete active session policy |
| Startup/shutdown registration | `js/vapi-background.js:1852-1890`, `:2403-2421` | Adds/removes observer and redirect-sink callbacks; no declarative rule registration |

`frameModule.js:237` `shouldLoad` supplies bookkeeping and returns ACCEPT.
`js/vapi-background.js:2130` requires an HTTP channel before calling the live
filter path. Observing category/observer registrations captures a callable
policy, not a finite set of conditions to install in another engine.

The cache is also not a generic interchange format. In
`js/static-net-filtering.js:272-283`, numeric filter class IDs are assigned by
constructor registration order. `:2069` serializes category/token maps and
class-specific `compile()` arrays; `:2311` consumes compiled good/bad filters.
`js/storage.js:1085-1126` generates the cache after a quiet interval, removes it
when invalidated, and checks an extension-specific magic value on restore.
Decoding this format requires knowledge of the extension version. A cached
static selfie alone omits current session dynamic rules and site exceptions.

## Why update-time decision capture is insufficient

There is no legacy service call registering effective rules at these update
points. Ordinary JS object/Map mutations inside the extension do not call a
browser policy service. Storage writes expose serialized values, but their keys,
grammar, precedence and completeness are extension-specific.

Sampling the live policy with hypothetical requests is not rule extraction.
Two policies can agree on every sampled URL and disagree on a future URL,
document domain, type or dynamic rule. Live evaluation may also change counters,
logger entries or page state. Such sampling cannot truthfully supply EasyList
coverage or preserve site exceptions. No synthetic channel or sampled-decision
cache is implemented.

The available choices are therefore a cooperating generic rule-export contract,
or an explicitly versioned extension-state adapter. The latter can keep the XPI
unchanged and emit only generic policy data, but is extension-specific knowledge;
it must not be described as automatic legacy-service emulation. Neither choice
requires the deferred broker for the representable compiled-rule subset.

## Current API coverage versus required extensions

Current source: `nsIContentRequestRule.idl`, `engine-scripts.js:setRequestRules`,
and `wpe/WPERequestFilters.cpp` in the Basilisk application repository.

| Feature | Current generic compiled API |
| --- | --- |
| HTTP(S)/WS(S) canonical case-sensitive URL prefix | Supported |
| Script/image/style/font/media/document/subdocument/fetch/socket/ping/other types | Supported; XHR and fetch share a class |
| First/third-party constraint | Supported through backend classification; not a claim of equivalence to every uBlock document-context rule |
| Top-document URL prefix | Supported; not requesting-frame origin |
| `||host^`, arbitrary substring, wildcards, regex, default case-insensitivity | Not expressed by the current prefix-only API |
| `@@` exceptions, `$important`, dynamic allow/noop precedence | Not expressed; all current rules block |
| Included/excluded `$domain` lists, subframe document-domain scope | Not expressed by the single top-page-prefix field |
| Response CSP/header policy, redirect replacement, scriptlet decisions | Not expressed by current request rules |
| Large lists | Current limit is 1,024 rules and 1 MiB generated JSON per policy |
| Private mode | Current filter store deliberately rejects private views to avoid persisting private policy data |
| Cosmetic/dynamic DOM filtering | CSS and isolated scripts exist separately; installing uBlock's content bootstrap is still required |
| Match counts/logger | Compilation completion is not a match event; do not synthesize counts from it |

These are **current shim limits**, not all upstream impossibilities. The pinned
WebKit `Source/WebCore/contentextensions/ContentExtensionParser.cpp:130-214`
accepts URL patterns, case options, resource/load flags, and top/frame conditions.
It rejects multiple condition kinds in a single trigger. At `:245` it accepts
ordered ignore-rule actions, and at `:251` CSS hiding. Mapping exceptions must
preserve policy ownership and precedence: one extension must not cancel another
extension's blocks. Mapping a domain constraint to a top-URL constraint without
checking frame semantics is incorrect.

A generic extension should introduce explicit pattern/condition/action semantics,
bounded list compilation, policy-local exceptions and transactional replacement.
It should reject unsupported predicates rather than broaden a rule silently.
An adapter must combine static rules, exceptions, active dynamic state and site
switches into a coherent generation before installation. The browser must retain
the last valid installed generation on compilation failure and expose the error.

## Validation boundary

The existing deterministic network suite was rerun for this investigation:
`DISPLAY=:92 python3 tools/contentengine/run-content-tests.py obj-webkit-enabled network`.
It passed server-counter assertions for blocked, disabled, re-enabled, restored
and independent Gecko cases, including script/image/style/subframe/XHR/fetch,
WebSocket and redirect-target pre-fetch blocking. This proves the existing
generic enforcement mechanism, **not uBlock rule ingestion**.

No production adapter, UXP change, extension modification or WPE patch is part
of this investigation. Real EasyList acceptance must follow successful state
ingestion and deterministic uBlock-triggered blocking; it is not yet established.

## Authorized adapter implementation

The user explicitly approved a documented, versioned uBlock state adapter after
this trace. `adapters/ublock-state.js` is the first isolated piece. It reads the
live engine's own `toSelfie()` output, active session/permanent rules and current
whitelist. It does not parse filter-list text, call request matchers, modify the
extension, or install enforcement rules yet. It is not packaged/loaded into
browser chrome until the consumer and lifecycle integration are ready.

`tools/contentengine/ublock/test-state.py <pinned.xpi>` verifies the package hash,
extracts fixed JavaScript members into a temporary directory, and runs the actual
extension compiler/engine with the reader. Tests passed for effective badfilter
removal, selfie restoration with empty raw filter sets, incremental user filters,
temporary versus permanent rules, whitelist changes, detached immutable state,
unchanged match registers, and version/schema/readiness rejection.

The strict clean-XPI browser audit was also rerun: Gecko blocking/cosmetics/toggle
controls passed; WPE still failed all nine network probes, cosmetics, page store,
logger, picker, extension reload and site toggle. This is a baseline failure,
not an expected-pass change. Logs for this run are
`/tmp/basilisk-compiled-policy-network.log` and
`/tmp/basilisk-compiled-policy-ublock.log`.
