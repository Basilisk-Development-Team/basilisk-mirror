> Historical investigation: the uBlock-specific adapter described here has been removed. See [replacement status](ublock-adapter.md). These results do not validate the new extension runtime.

# Compiled policy bundles

The application-owned logical policy remains an ordered sequence of block and
allow rules. The WPE adapter compiles large policies into physical lists with
at most 131,072 block rules each. Every part also contains all allow rules which
follow its first block. A matching block survives exactly when no subsequent
matching allow cancels it. Combining the surviving blocks across parts therefore
preserves the logical sequence, including blocks after exceptions. Policies
owned by different tokens are never merged.

Compilation uses one profile-local public WebKit filter store. Profiling the
four-store variant on LoongArch64 showed substantial allocator lock contention;
compiling fewer, larger parts serially avoids that contention and repeats fewer
exception predicates. Views in the same profile share the store's work queue.
All parts must finish successfully before any new part is
installed. The previous bundle stays attached while compiling. A failed part
rejects the whole update; superseded updates and closed views cannot install
late results. Disabling a token detaches its bundle without discarding it, so
site disable/re-enable does not recompile the full filter list.

This uses existing public embedding APIs only. No request-time IPC, upstream
WebKit changes, or privileged per-request filtering is involved. Compilation
progress reaches chrome through `ContentPolicyProgress`. Policy setup has a
120-second client deadline; ordinary content operations retain their 30-second
deadline. The separate navigation-response gate retains its bounded lifetime.
Private policy storage remains unsupported and must not open these stores.

Validation: the native network suite proves pre-fetch blocking, cross-owner
isolation, mixed document scopes, disable/re-enable, exception precedence across
multiple parts, and preserving the installed bundle when a later part fails.
The invalid-pattern diagnostic in that rollback test is intentional.

A four-entry process-local cache retains immutable compiled filter references.
A bounded profile-local disk cache now also retains up to four successful bundles
using the public WebKit filter-store save/load APIs. Its SHA-256 key covers the
profile path, complete ordered native rule encoding, partition size, adapter
cache-format version and running WebKit version. Unchanged filters can therefore
load after browser restart; changed rules or compiler versions use a different
key. Missing or invalid bytecode falls back to compilation. Cache reads still
complete the same atomic installation gate before navigation proceeds.

Store entries have deterministic `basilisk-policy-v1-<hash>.<part>` identifiers.
Normal view/token destruction preserves cached entries. Eviction uses the public
identifier enumeration/removal API, retains in-memory bundles first, and runs
only when no compilation is active. It never depends on WebKit's filename layout.
Removing an entry does not invalidate filter references already held by a view.
Private views continue to reject persistent filtering before opening a store.

Two independent tokens in the same view receive different physical identifiers,
including when their installations are pending concurrently. Otherwise removing
one token could detach the other's list. Updating an already-installed token with
identical data is a no-op that preserves its enabled/disabled state. Compilation
progress events are emitted for compiled parts, not memory/disk cache hits.

The application blocker also serializes installations of the same network
generation across tabs and windows. The first installation populates the shared
native cache; later views reuse it instead of queuing redundant cold compiles.
Site/settings-only changes share that preparation state. A rejected installation
releases waiting views to retry with their own lifetime; an unrelated network
generation has a separate queue. Navigation cancellation and stale-generation
checks remain in place.

The uBlock adapter canonicalizes rules within each precedence group. Fresh
dictionaries and restored selfies enumerate identical predicates differently;
without this step they would miss the disk cache. Block/allow/important ordering
is preserved. Translation yields keep their one-shot timers alive through the
callback so garbage collection cannot strand a pending preparation.

Regression commands (completed build required for native tests):

```sh
node tools/contentengine/test-blocking-lifecycle.js
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ policy-cache
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ network
DISPLAY=:92 python3 tools/contentengine/ublock/run-audit.py OBJ /path/to/clean.xpi --restarts 1 --cache-benchmark
```

The cache fixture restarts the browser with one disposable profile, verifies cold
versus warm compilation counts, corrupts the saved bytecode, changes the rules,
and checks eviction while another view retains an active bundle. Server counters
check blocking and exceptions before fetch in every phase. The uBlock restart
mode reuses the extension's saved full subscriptions and fails if unchanged rules
compile again. Existing logger/picker limitations remain separate from caching.
The first run of a new rule set still pays the native compilation cost.

The September 2026 LoongArch64 cache regression passed all four fresh-process
phases with 20,002 synthetic rules (20,003 after the rule change). Two concurrent
tabs compiled once on cold setup and zero times after restart. Corrupting the
stored bytecode caused one rebuild, which the second tab reused. Changing the
rules caused one new compile and changed the server-observed exception behavior.
The cache remained within four single-part entries after eviction, while another
view's retained filters continued blocking. These synthetic timings do not
represent the more complex full uBlock subscription set.

The full-list benchmark with the pinned unmodified uBlock 1.16.6.1 XPI translated
116,121 rules. Cold installation took 52,406 ms (60,136 ms including discovery
and translation); restart installation took 4,146 ms (11,340 ms including setup),
with zero compilation progress events. All nine blocked request counters stayed
zero and the allowed control loaded in both processes. This focused benchmark
does not assert logger/picker/UI parity. New subscriptions still need a cold
compile; subsequent tabs and unchanged browser restarts reuse the result.
