#!/bin/sh

if [ ! $(which docker) ]; then
    echo "Docker must be installed to run this script."
    exit
fi

# This probably isn't the best way to determine if we are in the Basilisk root directory but it works for now.
if [ ! -f aclocal.m4 ]; then
    echo "This script must be ran from the root of the Basilisk codebase."
    exit
fi

if [ ! -f .mozconfig ]; then
    if [ $(uname -m) = "x86_64" ]; then
        cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig
    elif [ $(uname -m) = "aarch64" ]; then
        cp mozconfigs/linux/aarch64/gtk3_unofficial_branding.mozconfig .mozconfig
    fi
fi

# If argument 1 is provided then apply patches before build
APPLYPATCHES=$1

echo "Starting Container..."

docker run -i -v $PWD:/share --platform=linux/arm64 --rm -e APPLYPATCHES=$APPLYPATCHES -e UID=$(id -u) -e GID=$(id -g) -e USERNAME=$(whoami) -e GROUPNAME=$(id -gn) -t oraclelinux:8 /share/build-scripts/linux/build_basilisk_subscripts/run_inside_docker.sh
