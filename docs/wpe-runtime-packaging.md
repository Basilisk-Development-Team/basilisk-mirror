# Relocatable WPE runtime

Enabled builds stage the selected installed WPE runtime into `dist/bin/webkit`.
The installer manifest includes that directory. Disabled builds neither inspect
the runtime prefix nor invoke the staging tool; they remove any old optional
runtime directory from the distribution.

```
application/
  basilisk
  libxul.so
  ...ordinary UXP libraries/resources...
  webkit/
    lib/                 WPE and dependency-prefix shared libraries
    lib/modules/         optional WPE platform modules
    libexec/             WebProcess, NetworkProcess, optional GPU helper
    extensions/          adapter-owned isolated-frame bridge module
    lib/gstreamer-1.0/    narrowly bundled webrtcbin/NICE plugins
    injected-bundle/     upstream injected bundle
    share/               Inspector gresource and upstream license notices
```

Every dynamic ELF in the distribution receives an `$ORIGIN`-relative RUNPATH to
its own directory, the application library directory and `webkit/lib`. Staging
copies external object-directory symlinks and breaks hardlinks before modifying ELF metadata.
Existing application-local `$ORIGIN` entries are preserved; external loader paths are discarded. It never
patches the installed dependency libraries or upstream sources. Shared libraries
are shipped once under their runtime SONAME. Normal UXP development chrome symlinks are resolved when
copying `dist/bin` (`cp -aL`, or the test runner) and by the ordinary packager.

This bundles the WPE runtime built in the dependency prefix, not the entire host
operating system. GTK/GLib, graphics drivers, GStreamer/plugins, fonts, bubblewrap,
xdg-dbus-proxy and other ordinary system dependencies still need to exist on the
target system. The complete ELF closure is checked on the test environment.

## Upstream build settings

WPE 2.54 compiles `WEBKIT_EXEC_PATH` and executable-relative helper discovery only
with `DEVELOPER_MODE`. A release-only WPE library otherwise uses its compiled
`PKGLIBEXECDIR`; copying its helpers alone is insufficient. The package tool
rejects a library without the upstream lookup override. The adapter validates
all required runtime files and sets the upstream helper, injected-bundle,
Inspector-resource and platform-module lookup variables from UXP's application
directory before creating any WPE session/view. It never falls back to the
development install or honors an unrelated runtime supplied through those variables.

With `ac_add_options --enable-webkit`, **`./mach build` builds WebKit** as
part of the application build. No separately installed WPE runtime or manual
invocation of the helper is required. Configuration checks the public system
dependencies and build tools without downloading or compiling WebKit.
The root build wrapper tracks application `moz.configure` files as configure
inputs, so existing object directories pick up these rules on `mach build` too.
Install the upstream WPE development dependencies, including CMake, Ninja,
gperf, and unifdef. Locally installed host tools in
`build-wpe-deps/prefix/bin` are accepted after the normal system PATH; this does
not select runtime libraries from that prefix.

The application's root compile graph makes both the native adapter and the
WebProcess extension depend on `wpe-runtime`. That target invokes
`tools/wpe/build-runtime.py` before either consumer compiles; libxul's existing
dependency on the adapter also orders its link. Independent UXP compilation can
run concurrently. A failed source check, CMake configuration, or WPE compilation
fails the application build. All hooks live outside `platform`.

On first build, missing sources are downloaded from the pinned URL, checked
against the recorded SHA-256, extracted into the source cache, and patched using
`third_party/webkit/patches/series`. Existing sources are verified, never repaired
or patched again. The source/archive cache is under `build-wpe-deps`; WPE's build
outputs and private install are per-object-directory:

```
OBJDIR/webkit/build/       CMake/Ninja build
OBJDIR/webkit/stage/usr/   private installed runtime and development files
OBJDIR/dist/bin/webkit/    packaged application runtime
```

Subsequent builds verify the source and let Ninja rebuild affected WPE targets.
GNU make's FIFO jobserver is shared with Ninja 1.13 or newer; older combinations
use a bounded four-job WPE build. Clobbering the object directory removes WPE's
build/install too, while retaining the downloaded source cache.

The helper uses upstream CMake with Release optimization, developer runtime
lookup enabled, API/layout tests, MiniBrowser, documentation/introspection and
clangd setup disabled, and the normal bubblewrap sandbox. It explicitly selects
WPEPlatform 2.0, disables the legacy libwpe API
and unused DRM/Wayland platform backends, and retains the headless backend.
Targets without a supported JSC JIT use CLoop. Restricted JSC development options
and developer sandbox-debug permissions remain disabled. Upstream developer mode adds read-only sandbox bindings for
executable/helper parent directories; this is upstream behavior, not a disabled
sandbox or private WebKit patch.

The compiled prefix remains `/usr`, so fallback paths never name the checkout.
`DESTDIR` installs into the object directory, **never the host `/usr`**. Only
build-time pkg-config metadata is rewritten to refer to that private install.
`patchelf` is required for enabled-build staging, not at runtime. GStreamer and
its installed codec/transport plugins remain system dependencies. With the
pinned GStreamer 1.28.1 configuration, mach also builds the existing narrow
WebRTC/NICE supplement using Meson in `OBJDIR/webkit/media`, sharing only its
verified download cache. Other GStreamer versions use matching system WebRTC
plugins. The separate `tools/wpe/build-webrtc-plugins.py` helper remains available
for explicitly managed prebuilt prefixes.

For developers deliberately supplying their own runtime,
`ac_add_options --with-wpe-runtime=/installed/prefix` bypasses the WPE build and
uses that prefix's headers, libraries, and helpers. The prefix must be complete
at configure time. Automatic source builds currently require a native build;
cross builds must select a runtime built for their target with this override.
The build no longer silently selects an old source-tree
staging directory or a system WPE install. `--disable-webkit` does not inspect,
fetch, compile, or stage WPE, even if a prebuilt prefix was also specified.

Standalone builds and custom upstream CMake settings remain available through
`tools/wpe/build-runtime.py`; additional CMake options follow `--`. Existing cache
options are retained. Select the resulting install with `--with-wpe-runtime`.

Build integration checks:

```sh
OBJDIR/_virtualenv/bin/python tools/wpe/test-configure.py
OBJDIR/_virtualenv/bin/python tools/wpe/test-build-configure.py
python3 tools/wpe/test-build-integration.py
python3 tools/wpe/test-verify-source.py
```

Validated on LoongArch64: an enabled `mach build` configured and compiled WPE in
a new object-directory WPE build tree, built/staged the WebRTC supplement, then
compiled the adapter/extension and linked Basilisk. The full build and following
incremental build both finished with zero compiler warnings. The incremental
run reused engine objects, regenerated an upstream resource bundle and relinked;
it completed in about 79 seconds. Changing the application configure rules also
triggered reconfiguration through `mach build` without a manual configure step.

The configure, parallel-ordering/failure, source-preparation and source-integrity
regressions passed. Clean extraction of the real pinned archive plus patch series
matched all 38,842 source entries. Real disabled and explicit-prebuilt configure
runs created no managed WPE build tree. The relocated runtime's 40 ELF files
resolved without `LD_LIBRARY_PATH`; Gecko, WPE HTTP/HTTPS, page scripts and the
Inspector passed with the checkout hidden. This does not change the previously
documented WebRTC ICE transport limitation. No `platform` source changes were
made for the integration.

## Relocation validation

```sh
DISPLAY=:93 python3 tools/wpe/check-runtime.py obj-webkit-enabled \
  --log /tmp/basilisk-relocated.log
python3 tools/wpe/check-disabled.py obj-webkit-disabled
# Also test an extracted installer archive:
DISPLAY=:93 python3 tools/wpe/check-runtime.py /path/to/extracted/basilisk \
  --packaged --log /tmp/basilisk-packaged.log
```

The enabled test copies the distribution into a fresh temporary directory,
dereferencing build symlinks. It audits every shipped ELF using `ldd` without any
LD_LIBRARY_PATH and rejects absolute/non-ORIGIN loader paths. The browser runs
with a minimal environment and a fresh profile in a mount namespace that hides
the entire checkout, including dependency/build directories. A file-system trace
rejects accesses to that hidden checkout and verifies application-local helper
execution. The smoke test covers Gecko, WPE HTTP/HTTPS, isolated script/messages,
upstream Inspector opening/closing and view destruction. An Inspector screenshot
and file trace accompany the requested log. This is not a sanitizer test or a
claim of portability to an OS with missing system dependencies.

## Recorded relocation results (LoongArch64)

The enabled build stages 35 ELF files. All passed `ldd` without LD_LIBRARY_PATH;
every dynamic loader path is application-relative. A copied `dist/bin` launched
with the complete checkout masked, using a fresh profile/minimal environment.
Gecko and WPE HTTP pages, WPE HTTPS, real-DOM script execution, isolated JSON
messaging, CSS, upstream Inspector and clean view destruction passed. The file
trace recorded application-local WebProcess/NetworkProcess execution and no
checkout access. The Inspector screenshot showed the real page DOM, injected CSS
and computed styles, not merely an empty host window. The interpreter frontend
needs several seconds to initialize; the test allows that time.

The disabled full build and audit passed (30 development ELF files). Its installer
archive also built; the installer stage's 22 ELF files resolved with no WPE
libraries or optional content-engine chrome. Upstream source comparison covered
38,842 archive files with zero modifications. JSC CLoop remains enabled and
JIT/DFG/FTL remain disabled. No sanitizer was run.

The enabled installer stage passed the same isolated launch test, including
all 27 shipped ELF files. This caught a missing `webcontentview.xpt` manifest entry
that the unpackaged build could not expose; the manifest now includes it only
under MOZ_WEBKIT. The disabled installer stage was regenerated successfully after
that correction. `--packaged` uses a separate test-only chrome registration in
the temporary copy, so it can exercise the real packaged `omni.ja` resources.

Finally, `make package` completed for both configurations. The final enabled
`.tar.xz` was extracted into a fresh temporary directory, checked for the required
runtime files and absence of staged test resources, and tested again with
`check-runtime.py --packaged`. All 27 ELF dependencies resolved; Gecko, WPE HTTPS,
scripts/messages and the upstream Inspector passed with the checkout hidden and
no LD_LIBRARY_PATH. No test-owned helper processes remained afterward. The
archive is self-contained for the bundled WPE build; the system dependencies
listed above remain required.


## WebRTC follow-up runtime (2026-09-26)

The current staged distribution contains **40 ELF files**, including the normal
public-API frame bridge module and narrow WebRTC additions. The bundled prefix
adds libnice 0.1.23, libgstwebrtcnice and the GStreamer 1.28.1 `webrtcbin`/NICE
plugins, built from checksum-verified upstream archives by
`tools/wpe/build-webrtc-plugins.py`. GStreamer core/base, DTLS/SRTP/SCTP/RTP plugins,
Opus/VP8 and other optional codecs remain system components; no host plugin tree
is copied. Unrelated host ONNX/OpenCV plugin warnings are not unresolved shipped
ELF dependencies and those plugins are not required for this test.

`basilisk-build.ini` ships actual feature booleans from CMake, without source or
build paths. The runtime uses application-relative plugin/extension/helper paths
and retains the normal WebKit sandbox. The fresh copied distribution passes the
hidden-checkout HTTPS/Inspector/frame-script and ELF audit. Its peer test proves
API exposure and SDP negotiation from that relocated runtime, but explicitly
reports the known ICE transport failure. A successful **packaging** audit is not
a successful WebRTC transport test; the focused WebRTC suite remains failing for
that feature. See [diagnosis](content-engine-navigation-webrtc-plan.md).

The test layout puts the application beneath `distribution/application` and its
XDG runtime directory outside `distribution`. Upstream developer-mode sandboxing
binds an executable's grandparent read-only; putting both the application and its
writable D-Bus sockets directly beneath the same temporary parent incorrectly
froze those sockets. The fixture now models a separate application install and
runtime directory. No sandbox workaround or upstream change was made.


Final regenerated installer validation: the enabled archive contains **32 ELF
files**, all resolving without LD_LIBRARY_PATH. Its extracted application passed
the same hidden-checkout HTTP/HTTPS/scripts/Inspector launch, with app-local
helpers/resources and the same explicit RTC transport limitation. The disabled
archive contains **22 ELF files** and no WebKit component/interface/resource or
library dependency. Neither archive includes temporary test chrome. See the
[full result ledger](content-engine-navigation-webrtc-results.md).

### Extension API patch requirement

The extension integration now uses downstream WPE APIs from
`third_party/webkit/patches/series`. A runtime selected with `--with-wpe-runtime`
must include that series; an upstream-only 2.54.0 build lacks the required symbols.
The default managed `mach build` prepares and applies the series automatically.
