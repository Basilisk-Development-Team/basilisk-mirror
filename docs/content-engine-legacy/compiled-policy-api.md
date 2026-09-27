# Compiled policy pattern extension

`browser.contentAPI.setRequestRules(token, rules)` still accepts existing URL
prefix rules unchanged. It now also accepts an exclusive `urlPattern` field:

```js
await browser.contentAPI.setRequestRules("owner-policy", [
  {urlPattern: "/advertising/", caseSensitive: false, action: "block"},
  {urlPattern: "/advertising/consent[.]js", action: "allow"}
]);
```

Patterns are bounded printable ASCII regular expressions supported by the
backend compiler. They are not ABP filter-list syntax. Unsupported expressions
reject the installation promise; they are never silently treated as literals.
Exactly one of `urlPrefix` and `urlPattern` is required. Case sensitivity defaults
to true, preserving existing prefix semantics. `action` defaults to `block`.

Rules are ordered. `allow` cancels preceding matches in the **same policy token**;
subsequent block rules can block again. It cannot override another owner's
separately installed policy. This permits normal blocks, exceptions, then
important blocks without global exception leakage. It is not yet an automatic
translation of extension dynamic rules or all uBlock precedence semantics.

Existing type, party and top-URL prefix fields retain their semantics. Each
policy accepts at most 150,000 rules, 8,192 bytes per pattern/prefix, and 64 MiB
of backend JSON. Installation is asynchronous and transactional: compilation
failure retains the previous installed policy. Callers must await successful
installation before starting the navigation they intend to protect.

The content-view shim additionally supports `setRequestRulesEnabled(token,
enabled)` for application-owned policies. Disabling detaches the compiled list
while retaining it for immediate reattachment. Updating a disabled list keeps
it disabled; removal releases it. This avoids recompiling an entire subscription
on each site toggle. Server-counter tests cover disable, update while disabled,
and re-enable. It is not a new Gecko request-policy path.

Requesting-document conditions accept either `documentURLPattern` or the
nonempty `documentURLPatterns` array. Array members form a union; optional
`excludeDocumentURL` negates that union. These cannot be combined with
`topURLPrefix`. Each array contains at most 16,384 printable ASCII patterns,
8,192 bytes per pattern and 1 MiB in total. The internal interface packs them
with LF separators (LF is forbidden inside patterns); the backend emits one
condition array rather than duplicating a complete rule per domain. A mixed
origin iframe/server-counter test verifies that both union members apply to
their own documents. These are document URLs, not inferred security origins.

The project-owned predicate helpers lower DNS suffix inclusion/exclusion and
bounded regex alternation/counts into this representation. Counted repetitions
up to 64 are supported, with bounded expansion; unsupported assertions,
backreferences and unbounded repeated alternatives still reject.

Validation on the enabled LoongArch64 build:

* Existing server-counter resource matrix passes.
* Pattern rules block HTTP and WebSocket resources before fetch.
* Case-insensitive matching and ordered exceptions pass.
* A separate owner's broad allow does not erase another policy's blocks.
* Invalid pattern compilation rejects and retains the previous working policy.
* Invalid combinations/actions/types reject; engine switching retains policy.
* Disabled build passes its 30-ELF dependency/component/resource audit.

Logs: `/tmp/basilisk-policy-pattern-build.log`,
`/tmp/basilisk-pattern-policy-network.log`,
`/tmp/basilisk-pattern-disabled-build.log`.

This adds no upstream WPE patch, UXP change, runtime broker, or extension identity
knowledge to the generic interface/backend. Inherited/opaque origins and the
backend's top-document party classification remain separate limitations.
