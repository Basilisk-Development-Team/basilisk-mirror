# EGL-enabled private libepoxy dependency

The MacPorts build lacks EGL dispatch and headers. The pinned upstream version
also hardcodes `PLATFORM_HAS_EGL=0` on Darwin even with Meson `-Degl=yes`.
The patch honors that explicit option and supplies Darwin EGL/GLES2 library names.
Default `egl=auto` remains off on Darwin; no default EGL runtime is required.
No public API is added. This is a generally applicable optional-EGL build fix.

Build in the private prefix using:

```
meson setup <build> <source> --prefix <prefix> \
  -Degl=yes -Dglx=no -Dx11=false -Dtests=false \
  -Dc_args=-I<full-WebKit-source>/Source/ThirdParty/ANGLE/include
ninja -C <build>
ninja -C <build> install
```

Stage the pinned ANGLE `include/EGL` and `include/KHR` directories in the same
prefix's include directory for consumers. Preserve their license notices.
No system installation is modified.

Validation: the patched dispatcher builds and installs its dylib and EGL
headers on arm64 Darwin. The real ANGLE Metal pbuffer smoke test also passes
through this dispatcher, including context creation, GLES clear/readback and
teardown. Browser compositing/presentation remains untested.

`python3 tools/wpe/test-darwin-egl-dispatch.py` passes dylib discovery and symbol
dispatch using a disposable test EGL library. It deliberately creates no real
graphics context and must not be reported as a rendering test.
