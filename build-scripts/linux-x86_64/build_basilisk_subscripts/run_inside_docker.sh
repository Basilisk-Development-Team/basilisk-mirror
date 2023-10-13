#!/bin/sh

if [ "$UPDATEFIRST" = "yes" ]; then
    echo "Updating Packages..."
    yes y | slackpkg -default_answer=yes -batch=on update gpg
    slackpkg -default_answer=yes -batch=on update
    slackpkg -default_answer=yes -batch=on upgrade-all
    slackpkg -default_answer=yes -batch=on install-new
    slackpkg -default_answer=yes -batch=on clean-system
fi

echo "Prepping user and group inside docker container..."
groupadd -r -g $GID $GROUPNAME
useradd -u $UID $USERNAME -g $GID


echo "Building Basilisk..."
cd /share

if [ "$APPLYPATCHES" = "yes" ]; then
    patch -p1 < patches/0001-goanna-disable-pref.diff
fi

su -c "./mach clobber" $USERNAME
su -c "./mach configure" $USERNAME
su -c "./mach build" $USERNAME
su -c "./mach package" $USERNAME
