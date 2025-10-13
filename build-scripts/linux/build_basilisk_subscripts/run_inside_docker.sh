#!/bin/bash

if [ "$SETUP_BUILD_IMAGE" = "1" ]; then
  set -e

  dnf install -y epel-release

  dnf config-manager --set-enabled ol8_codeready_builder

  dnf install -y gtk3-devel dbus-glib-devel GConf2-devel yasm mesa-libGL-devel \
    alsa-lib-devel libXt-devel openssl-devel sqlite-devel pulseaudio-libs-devel \
    python2 gtk2-devel python2-devel wget xz make cmake python2 which

  dnf groupinstall -y 'Development Tools'

  dnf install -y gcc-toolset-11 gcc-toolset-11-annobin*

  # Install dependencies to build an i686 build if building on x86_64
  if [ "$(uname -m)" = "x86_64" ]; then
      dnf install -y glibc-devel.i686 libstdc++-devel.i686 gcc-toolset-11-libstdc++-devel.i686 \
      fontconfig-devel.i686  freetype-devel.i686 gtk2-devel.i686 gtk3-devel.i686 libXt-devel.i686 \
      libXext-devel.i686 libX11-devel.i686 libX11-xcb.i686 libxcb-devel.i686 glib2-devel.i686 \
      pulseaudio-libs-devel.i686 GConf2-devel.i686 dbus-devel.i686 atkmm-devel.i686 \
      libXrender-devel.i686 alsa-lib-devel.i686 atk-devel.i686  pango-devel.i686 dbus-glib-devel.i686 \
      libXfixes-devel.i686 libXcomposite-devel.i686 libXdamage-devel.i686 gdk-pixbuf2-devel.i686 \
      cairo-gobject-devel.i686 gcc-toolset-11*.i686
  fi

  # Clang toolchain
  dnf install -y clang llvm lld

  ln -s /usr/bin/python2 /usr/local/bin/python

  exit 0
fi

echo "Prepping user and group inside docker container..."
groupadd -r -g $GID $GROUPNAME
useradd -u $UID $USERNAME -g $GID

echo "Building Basilisk..."
cd /share

if [ "$APPLYPATCHES" = "yes" ]; then
    patch -p1 < patches/0001-goanna-disable-pref.diff
fi

# Enable GCC 11
. /opt/rh/gcc-toolset-11/enable

# Check for mozconfig before building, add fallback if none present
if [ ! -f .mozconfig ]; then
    if [ $(uname -m) = "x86_64" ]; then
        cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig
    elif [ $(uname -m) = "aarch64" ]; then
        cp mozconfigs/linux/aarch64/gtk3_unofficial_branding.mozconfig .mozconfig
    fi
fi

mkdir -p /opt/llvm-libcxx-static
cd thirdparty/libcxx-static

# Install LLVM libc++ and libc++abi static libraries
cmake -S runtimes -B build \
  -DLLVM_ENABLE_RUNTIMES="libunwind;libcxxabi;libcxx" \
  -DLIBUNWIND_ENABLE_SHARED=OFF \
  -DLIBUNWIND_USE_STATIC_LIBS=ON \
  -DLIBCXXABI_ENABLE_SHARED=OFF \
  -DLIBCXX_ENABLE_SHARED=OFF \
  -DLIBCXXABI_USE_LLVM_UNWINDER=ON \
  -DLIBCXX_USE_COMPILER_RT=ON \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=clang \
  -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_INSTALL_PREFIX=/opt/llvm-libcxx-static \
  -DLIBCXX_CXX_ABI=libcxxabi \
  -DLIBCXX_HAS_ATOMIC_LIB=OFF \
  -DLIBCXX_ENABLE_EXPERIMENTAL_LIBRARY=OFF \
  -DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON \
  -DLIBCXX_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXX_ENABLE_RTTI=OFF \
  -DCMAKE_CXX_FLAGS="-fPIC -fvisibility=hidden -fvisibility-inlines-hidden"

cmake --build build -j$(nproc)
cmake --install build

if [ "$(uname -m)" = "x86_64" ]; then
  # Install 32-bit i686 LLVM libc++ and libc++abi static libraries
cmake -S runtimes -B build-i686 \
  -DLLVM_ENABLE_RUNTIMES="libunwind;libcxxabi;libcxx" \
  -DLIBUNWIND_ENABLE_SHARED=OFF \
  -DLIBUNWIND_USE_STATIC_LIBS=ON \
  -DLIBCXXABI_ENABLE_SHARED=OFF \
  -DLIBCXX_ENABLE_SHARED=OFF \
  -DLIBCXXABI_USE_LLVM_UNWINDER=ON \
  -DLIBCXX_USE_COMPILER_RT=ON \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=clang \
  -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_INSTALL_PREFIX=/opt/llvm-libcxx-static-i686 \
  -DLIBCXX_CXX_ABI=libcxxabi \
  -DLIBCXX_HAS_ATOMIC_LIB=OFF \
  -DLIBCXX_ENABLE_EXPERIMENTAL_LIBRARY=OFF \
  -DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON \
  -DLIBCXX_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXX_ENABLE_RTTI=OFF \
  -DCMAKE_CXX_FLAGS="-m32 -fPIC -fvisibility=hidden -fvisibility-inlines-hidden" \
  -DCMAKE_C_FLAGS="-m32"

  cmake --build build-i686 -j$(nproc)
  cmake --install build-i686
fi

cd ../../

su -c "./mach clobber" $USERNAME
su -c "./mach configure" $USERNAME
su -c "./mach build" $USERNAME
su -c "./mach package" $USERNAME
