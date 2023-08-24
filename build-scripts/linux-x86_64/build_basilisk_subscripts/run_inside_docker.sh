#!/bin/sh

if [ -n "$UPDATEFIRST" ]; then
    echo "Updating Packages..."
    yes y | slackpkg -default_answer=yes -batch=on update gpg
    slackpkg -default_answer=yes -batch=on update
    slackpkg -default_answer=yes -batch=on upgrade-all
    slackpkg -default_answer=yes -batch=on install-new
    slackpkg -default_answer=yes -batch=on clean-system
fi

echo "Installing Autoconf 2.13..."
git clone https://repo.palemoon.org/Basilisk-Dev/autoconf213-slackbuild ~/autoconf213-slackbuild
cd ~/autoconf213-slackbuild
wget https://ftp.gnu.org/gnu/autoconf/autoconf-2.13.tar.gz
wget http://www.linuxfromscratch.org/patches/blfs/svn/autoconf-2.13-consolidated_fixes-1.patch
sudo ./autoconf213.SlackBuild
sudo upgradepkg --install-new /tmp/SBo/autoconf213-2.13-noarch-1.txz

echo "Prepping user and group inside docker container..."
groupadd -r -g $GID $GROUPNAME
useradd -u $UID $USERNAME -g $GID


echo "Building Basilisk..."
cd /share
su -c "./mach clobber" $USERNAME
su -c "./mach configure" $USERNAME
su -c "./mach build" $USERNAME
su -c "./mach package" $USERNAME