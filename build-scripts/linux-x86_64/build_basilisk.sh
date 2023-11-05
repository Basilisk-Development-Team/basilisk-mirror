#!/bin/sh

if [ ! $(which docker) ]; then
    echo "Docker must be installed to run this script."
    exit
fi

if [ $(uname -s) != "Linux" ]; then
    echo "This script is only meant to be ran on Linux."
    exit
fi

# This probably isn't the best way to determine if we are in the Basilisk root directory but it works for now.
if [ ! -f aclocal.m4 ]; then
    echo "This script must be ran from the root of the Basilisk codebase."
    exit
fi

# If argument is provided then container will update before build
UPDATEFIRST=$1

if [ ! -f .mozconfig ]; then
    cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig
fi

# If argument 2 is provided then apply patches before build
APPLYPATCHES=$2

echo "Starting Container..."

# Slackware was selected because of the combination of stability and ease of use.
docker run -i -v $PWD:/share --rm -e UPDATEFIRST=$UPDATEFIRST -e APPLYPATCHES=$APPLYPATCHES -e UID=$(id -u) -e GID=$(id -g) -e USERNAME=$(whoami) -e GROUPNAME=$(id -gn) -t basiliskdev/slackware14-uxp:latest /share/build-scripts/linux-x86_64/build_basilisk_subscripts/run_inside_docker.sh
