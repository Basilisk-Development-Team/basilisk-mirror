#!/bin/sh

if [ ! $(which docker) ]; then
    echo "Docker must be installed to run this script."
    exit
fi

if [ $(uname -s) != "Linux" ]; then
    echo "This script is only meant to be ran on Linux."
    exit
fi

if [ ! -f aclocal.m4 ]; then
    echo "This script must be ran from the root of the Basilisk codebase."
    exit
fi

# If argument is provided then container will update before build
UPDATEFIRST=$1

cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig

echo "Starting Container..."

# Slackware was selected because of the combination of stability and ease of use
docker run -i -v $PWD:/share --rm -e UPDATEFIRST=$UPDATEFIRST -e UID=$(id -u) -e GID=$(id -g) -e USERNAME=$(whoami) -t aclemons/slackware:15.0-full /share/build-scripts/linux-x86_64/build_basilisk_subscripts/run_inside_docker.sh