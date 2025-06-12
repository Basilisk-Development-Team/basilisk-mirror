#!/bin/bash

if [ "$SETUP_BUILD_IMAGE" = "1" ]; then
  set -e

  CCACHE_VERSION="4.10.2"

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
      cairo-gobject-devel.i686
  fi

  ln -s /usr/bin/python2 /usr/local/bin/python

  cd /tmp
  wget https://github.com/ccache/ccache/releases/download/v$CCACHE_VERSION/ccache-$CCACHE_VERSION.tar.xz
  tar -xvf ccache-$CCACHE_VERSION.tar.xz
  cd ccache-$CCACHE_VERSION
  cmake .
  make install
  cd ..
  rm -rf ccache*

  set +e

  exit 0
fi

echo "Prepping user and group inside docker container..."
groupadd -r -g $GID $GROUPNAME
useradd -u $UID $USERNAME -g $GID

chmod -R 775 /.ccache
chown -R $USERNAME:$GROUPNAME /.ccache
export CCACHE_DIR=/.ccache

echo "Building Basilisk..."
cd /share

if [ "$APPLYPATCHES" = "yes" ]; then
    patch -p1 < patches/0001-goanna-disable-pref.diff
fi

# Enable GCC 11
. /opt/rh/gcc-toolset-11/enable

which ccache &> /dev/null
if [ $? -eq 0 ]; then
  export CC="ccache $(which gcc)"
  export CXX="ccache $(which g++)"
fi

# Check for mozconfig before building, add fallback if none present
if [ ! -f .mozconfig ]; then
    if [ $(uname -m) = "x86_64" ]; then
        cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig
    elif [ $(uname -m) = "aarch64" ]; then
        cp mozconfigs/linux/aarch64/gtk3_unofficial_branding.mozconfig .mozconfig
    fi
fi

su -c "./mach clobber" $USERNAME
su -c "./mach configure" $USERNAME
su -c "./mach build" $USERNAME
su -c "./mach package" $USERNAME
