> Historical investigation: the uBlock-specific adapter described here has been removed. See [replacement status](ublock-adapter.md). These results do not validate the new extension runtime.

# Full-list policy setup failure — September 2026

The reported failure was a WebKit tab titled `Content policy setup failed` when
loading adblock-tester.com with the normal unmodified uBlock installation.
This was not an HTTPS failure. Chrome awaited policy preparation and rejected
navigation before loading the page.

## Causes and changes

* Behavioral exceptions (popup, generic-hide, etc.) incorrectly invalidated the
  ordinary resource policy. They now remain separate from ordinary network
  exceptions. Generic-hide state is evaluated by uBlock for cosmetic filtering.
* Rule/type and domain-predicate expansion multiplied full-list output. Equal
  predicates now share resource masks, document conditions remain unions, and
  pure domain exclusions use a negated union. ASCII regex classes and bounded
  quantifiers are lowered into equivalent supported patterns.
* Long synchronous translation and cross-compartment traversal triggered the
  chrome watchdog. Translation yields between batches, caches repeated
  predicates, skips unsupported behavioral dictionaries, and transfers bulk
  rules as serialized values. Superseded generations cannot publish results.
* Compiling full policies exceeded the old operation deadline. Policy compilation
  has a bounded setup deadline, atomic replacement, exception-preserving bundles,
  and a four-entry immutable compiled-policy cache. Profiling found allocator
  contention with parallel stores; the final implementation compiles serially.
  See [compiled-policy-bundles.md](compiled-policy-bundles.md).
* Site changes unnecessarily recompiled static rules. Network generations are
  now distinct from site/settings generations; disabling detaches a policy,
  and re-enabling retains it.
* Reload did not mark the tab busy before awaiting policy preparation. It now
  uses the same cancellable preparation path as navigation. Stop cancels a
  queued reload. Context-menu and native-keyboard reloads also use this path.

All implementation changes are Basilisk-owned. No UXP, upstream WPE/WebKit or
installed extension source changes were made. No request broker was introduced.

## Results

On the tested LoongArch64 build, the normal full-list audit translated 116,121
ordinary network rules from clean uBlock 1.16.6.1. Both Gecko and WebKit loaded
adblock-tester.com and the site's own page reported **100 points out of 100**.
That score is a site diagnostic, not proof of complete extension compatibility.

The deterministic server recorded zero matching requests for script,
third-party script, image, stylesheet, iframe, XHR, fetch, WebSocket and redirect
target. Allowed controls loaded. Domain-specific and dynamic DOM cosmetic targets
were hidden. Generic cosmetics and exceptions passed the controlled user-list
run. The full-list run correctly retained EasyList's generic-hide exception for
loopback URLs. Site disable/re-enable allowed and blocked the same resources.

The final full-list timing sample compiled in about 50.6 seconds and completed
initial preparation in about 57.8 seconds. A second tab loaded in about 4.5 seconds
without recompiling; blocked counters remained zero. Cold preparation is still
expensive in that implementation and recurred after application restart.
The subsequent [persistent-cache change](compiled-policy-bundles.md) retains
compiled bundles across restarts and shares cold preparation across tabs; the
figures above describe the earlier process-local implementation.
The normal audit's 60-second navigation deadline was not relaxed. Separate,
longer diagnostic runs were used to measure earlier failing implementations.

The strict unmodified-uBlock acceptance test still exits nonzero for:

* request logger has no alternate-engine request entries;
* element picker is not injected into alternate content.

These checks remain enabled. No request count or matched-filter identity is
fabricated. The compiled-policy public API does not supply the per-request
observation/attribution needed for native logger/accounting parity. Picker and
procedural-content integration still require additional application-side work.

Other known differences remain: dynamic firewall/URL-rule enforcement,
procedural cosmetics, scriptlets, some regex constructs, behavioral filtering,
object/plugin attribution, private compiled-policy storage, and complete
requesting-frame first/third-party semantics. Object exceptions conservatively
underblock their retained predicates. Unsupported ordinary network exceptions
still reject preparation. This work does **not** make uBlock 100% Gecko-equivalent.

## Regression and source checks

* Full default subscriptions: **100 Gecko → WebKit → Gecko cycles passed** in
  605,130 ms. Each cycle checked both engines, all nine blocked server counters,
  allowed content and cosmetic state. The overall strict runner still exited 1
  for the logger and picker failures listed above; extension error collection
  was empty. This is not a sanitizer or memory-leak proof.
* Native network suite: pre-fetch counters, document scope, precedence across
  physical parts, failed-part rollback, cache lifetime and independent owners.
* Navigation preparation: allow/deny, Stop, replacement, timeout, crash, tab close,
  and reload busy-state/cancellation regression.
* Legacy runtime: separate worlds, ordered scripts, snapshots, messaging,
  registered phases, dynamic frames, private/cross-window ownership, recovery,
  and 100 independent world create/release cycles.
* Relocated distribution: 40 ELF files resolve without `LD_LIBRARY_PATH`; the
  copied browser runs with the checkout hidden and uses packaged helpers.
* Disabled build: 30 ELF files audited; no WebKit dependencies, components,
  interfaces, resources or feature define.
* Upstream verification: 38,842 WPE source entries, zero downstream patches.
* Clean XPI SHA-256:
  `9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`.
* UXP gitlink remains `f865b384ebe9a86d17e0f015482d8b5d7bb283bc`.
  The pre-existing clean checkout at
  `845e0e1a2ffd48d33a48ca89fa72acc61399395b` was left untouched.

Reproduce the strict full-list audit (failure remains meaningful):

```
DISPLAY=:92 python3 tools/contentengine/ublock/run-audit.py obj-webkit-enabled /path/to/clean.xpi --require-webkit --site https://adblock-tester.com/
```

`--automatic` selects only controlled user filters while keeping production
adapter synchronization. Omit it for the normal subscribed lists. Neither mode
manually refreshes or installs the adapter's policies. `--switches 100` adds
server-counter and cosmetic checks over 100 Gecko/WebKit/Gecko cycles; only the
overall process watchdog scales with that additional workload, not individual
navigation deadlines.
