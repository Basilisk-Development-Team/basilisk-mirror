# Compiled policy bundles

The application-owned logical policy remains an ordered sequence of block and
allow rules. The WPE adapter compiles large policies into physical lists with
at most 8,192 block rules each. Every part also contains all allow rules which
follow its first block. A matching block survives exactly when no subsequent
matching allow cancels it. Combining the surviving blocks across parts therefore
preserves the logical sequence, including blocks after exceptions. Policies
owned by different tokens are never merged.

Four profile-local public WebKit filter stores bound concurrent compilation.
WebKit serializes compilation by store path; views in the same profile reuse
these four paths. All parts must finish successfully before any new part is
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
Its SHA-256 key covers the profile path and complete ordered native rule encoding.
It does not retain browsing URLs or introduce a new persistent database. Store
files can be removed when the original owner closes: the public filter reference
retains the compiled object. Cache hits are only shared across content managers;
two independent tokens in the same view still receive separate physical list
identifiers. Otherwise removing either token could detach the other's list.
The cache is cleared at application shutdown. Native server-counter tests cover
reuse after original-view destruction and independent removal of two owners.
