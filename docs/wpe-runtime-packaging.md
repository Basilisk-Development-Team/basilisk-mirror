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

`tools/wpe/build-runtime.py` uses pristine upstream CMake with Release optimization,
developer lookup enabled, tests/MiniBrowser/clangd setup disabled, and the normal
bubblewrap sandbox enabled. Developer sandbox-debug permissions are not enabled.
Upstream developer mode also adds read-only sandbox bindings for executable/helper
parent directories; this is upstream behavior, not a disabled sandbox or private
WebKit patch. A future nondeveloper relocatable-helper API would remove the need
for this build option.

The compiled install prefix is conventional `/usr`, so sandbox bind arguments and
fallback paths do not name the source/dependency checkout. `DESTDIR` installs into
a private staging directory, **never the host `/usr`**. Only build-time pkg-config
metadata is adjusted to find that staged install. It is not shipped in the app.
JSC JIT is not required. Example using an already configured dependency build:

```sh
python3 tools/wpe/build-runtime.py \
  --build build-wpe-deps/wpe-build --interpreter --jobs 16
export PKG_CONFIG_PATH="$PWD/build-wpe-deps/runtime-stage/usr/lib64/pkgconfig"
MOZCONFIG=/path/to/enabled.mozconfig ./mach configure
MOZCONFIG=/path/to/enabled.mozconfig ./mach build
```

Configure remains explicitly opt-in with `--enable-webkit`. It normally obtains
the runtime prefix from WPE pkg-config; `--with-wpe-runtime=/installed/prefix`
can select a matching installed runtime explicitly. `patchelf` is an enabled-build
staging dependency, not a runtime dependency. Additional upstream dependency or
feature options can be passed to the build helper after `--`; existing CMake cache
options are retained. Upstream may require a new build directory when changing an
explicitly stamped developer-mode identity. No source patch is needed.

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
