#!/bin/bash

echo "Prepping user and group inside docker container..."
groupadd -r -g $GID $GROUPNAME
useradd -u $UID $USERNAME -g $GID

dnf install -y epel-release

dnf config-manager --set-enabled ol8_codeready_builder

dnf install -y gtk3-devel dbus-glib-devel GConf2-devel autoconf213 yasm \
mesa-libGL-devel alsa-lib-devel libXt-devel openssl-devel sqlite-devel \
pulseaudio-libs-devel python2 gtk2-devel

dnf groupinstall -y 'Development Tools'

dnf install -y gcc-toolset-11
. /opt/rh/gcc-toolset-11/enable

echo "Building Basilisk..."
cd /share

if [ "$APPLYPATCHES" = "yes" ]; then
    patch -p1 < patches/0001-goanna-disable-pref.diff
fi

su -c "./mach clobber" $USERNAME
su -c "./mach configure" $USERNAME
su -c "./mach build" $USERNAME
su -c "./mach package" $USERNAME
