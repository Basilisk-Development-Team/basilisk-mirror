# Legacy extension compatibility

The versioned uBlock state reader, filter translator, and automatic policy installer
have been removed. Basilisk no longer packages `LegacyBlockingExtensions.jsm`,
`engine-blocking.js`, or `adapters/ublock-state.js`.

The replacement delivers requests to ordinary HTTP observers,
loads installed extension frame/process scripts, and routes their message-manager
calls to the unchanged parent extension. Content scripts execute in isolated
WebKit worlds. WPE changes are maintained in `third_party/webkit/patches/series`
and applied by the managed build. No UXP changes are required by these additions.

The unchanged-XPI audit is:

```
DISPLAY=:92 python3 tools/contentengine/ublock/run-audit.py \
  obj-loongarch64-unknown-linux-gnu <clean-ublock.xpi> \
  --require-webkit --switches 3 --restarts 1
```

There is no translated-policy fallback. Old adapter and policy-cache tests were
removed with the implementation. Earlier results in adjacent investigation
notes describe the removed implementation and do not validate this replacement.

## Validated coverage

The managed application build and the strict unchanged-XPI browser audit passed
with uBlock Origin 1.16.6.1 (SHA-256
`9ef1fd80f9a2350da9e182d991e6ff2b81a5dc11b36d7d26659b3560c367f8cf`).
The audit verifies that blocked scripts, third-party scripts, images, stylesheets,
frames, fetches, XHRs, WebSockets, and redirect targets never reach the fixture
server. It also checks static, dynamic, and generic cosmetic filters and an
exception, the extension's page store, popup, logger, picker injection, reload,
per-site toggles, and three mixed Gecko/WebKit engine switches both before and
after a browser restart using the same profile. Each launch also disables and
re-enables the actual add-on with an existing WebKit tab and verifies restored
filtering. Both runs finish without extension errors. The XPI hash is checked
before and after each run. Filter setup uses the extension's own settings APIs.

The extension selects its legacy toolbar implementation on UXP 6.9. That code's
direct DOM insertion does not save a Basilisk customization placement. The audit
places its original widget using the normal customization API on first launch;
it does not change extension code or spoof the platform version.

The `xul-extensions` fixture separately tests ordinary installed-addon frame
scripts, DOM changes, isolated userscript sandboxes, parent/child messaging,
registered and document user styles, UXP version comparisons,
request-header addition/removal, response headers, request
cancellation, suspension/resumption with the original POST body, live
non-delayed frame scripts, SessionStore flushes through the backing loader, and
extension-disable broadcasts/style removal.
Separate cookie and frame fixtures also pass: cookie clearing/shutdown and the
new-tab menu, document script timing, CSP isolation, dynamic-frame teardown,
stale frame IDs, and history restoration. Runtime `webkit.enabled` gating and
the configure/build gates are covered separately; a complete second binary
built with `--disable-webkit` has not been built in this validation run.

## Compatibility limits

This is not complete Gecko content-XPCOM compatibility. Parent-side extensions
that dereference `browser.contentWindow` or `browser.contentDocument` still
cannot access a WebKit document through those Gecko objects. The content runtime
implements content-side interfaces and delegates parent-owned XPCOM services
through document-scoped handles and asynchronous callbacks. Installed extension
scripts run in a trusted isolated WebKit world; userscript sandboxes use separate
worlds. Native service handles are revoked and observers/timers/requests cleaned
up when their document goes away. Imported modules and observers are shared
across a page's frames, while frame-script globals belong to the top-level tab.
The browser's `messageManager` and `frameLoader.messageManager` route to the same
extension sender. Native frame-loader operations retain the Gecko backing loader;
SessionStore compares the native loader identity when accepting flush replies.

This does not turn arbitrary parent native services into WebKit DOM services.
Callbacks that require an immediate synchronous return to a parent native call,
arbitrary native DOM reflectors, custom extension protocol transports, and full
Gecko sandbox options/revocation are not yet implemented. `unsafeWindow` can reach
page globals, but transparent `wantXrays: false` prototype behavior and arbitrary
cross-engine DOM wrappers do not yet have full Gecko
semantics. Document styles currently use user origin, including the window-utils
bridge; agent/author-origin stylesheet behavior is not implemented there.

The HTTP channel facade supports the tested observer, header, redirect, cancel,
and pending-decision suspend/resume operations. It does not expose response-body
streams, arbitrary Gecko channel internals, or TLS security interfaces. Cancel
after a policy decision has already been handed back to the transport is not
equivalent to cancelling a live Gecko channel. These are remaining implementation
gaps, not guarantees supplied by the passing uBlock audit. The audit exercises
fixture filters, not every feature or every public filter list.

## Greasemonkey

The unchanged upstream [Greasemonkey 3.11 source](https://github.com/greasemonkey/greasemonkey/tree/3.11)
is packaged locally for the audit; this is not an official signed release XPI.
No source, manifest, or extension preference names are patched to make it run.
The source archive is
`https://codeload.github.com/greasemonkey/greasemonkey/tar.gz/refs/tags/3.11`, with
SHA-256 `975d91383427cca96becba74c0f29e2aec2174f607282a44226196d8da872f91`.
The deterministic local XPI has SHA-256
`c591b6704eaa2df512d4cc6ee0ba49b06b348ecf2c86f1d04fb0c2c08e776b66`.

```
python3 tools/contentengine/greasemonkey/package-upstream.py \
  greasemonkey-3.11.tar.gz greasemonkey-3.11.xpi
DISPLAY=:93 python3 tools/contentengine/run-content-tests.py \
  obj-loongarch64-unknown-linux-gnu greasemonkey --xpi greasemonkey-3.11.xpi
```

The fixture installs ordinary userscripts through the extension's own installer.
It tests Gecko and WebKit against the same scripts: DOM changes, `GM_addStyle`,
script-value storage, cross-origin `GM_xmlhttpRequest` POST callbacks, `@require`,
resource text, `unsafeWindow`, document-start/end/idle, same-origin/cross-origin
subframes, `@noframes`, matching-script popup entries, and menu command
discovery/invocation. It also checks that
ordinary page code and userscript sandboxes cannot read cross-origin frame DOM,
and that userscripts cannot obtain privileged native services. Both engines
passed these probes. Source and installed XPI hashes are checked after each run.

Greasemonkey 3.17 was also tried unchanged. It fails in the Gecko control at its
WebExtension migration dependency, `LegacyExtensionsUtils.jsm`, which this UXP
build does not provide. It is not counted as a WebKit compatibility success.
