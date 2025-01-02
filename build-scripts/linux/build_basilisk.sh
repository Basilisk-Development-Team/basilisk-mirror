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

if [ ! -f .mozconfig ]; then
    if [ $(uname -m) = "x86_64" ]; then
        cp mozconfigs/linux/x86_64/gtk3_unofficial_branding.mozconfig .mozconfig
    elif [ $(uname -m) = "aarch64" ]; then
        cp mozconfigs/linux/aarch64/gtk3_unofficial_branding.mozconfig .mozconfig
    fi
fi

DOCKER_DEV_NAME="basilisk_builder"
d=$(docker images -f reference="$DOCKER_DEV_NAME" --format '{{.ID}}' | wc -l)

if [ $d -eq 0 ]; then
  set -e

  docker rm $DOCKER_DEV_NAME-setup || true

  docker run -it \
    -v $PWD:/share \
    --name $DOCKER_DEV_NAME-setup \
    oraclelinux:8 \
    env SETUP_BUILD_IMAGE=1 /share/build-scripts/linux/build_basilisk_subscripts/run_inside_docker.sh

  docker commit $DOCKER_DEV_NAME-setup $DOCKER_DEV_NAME
  docker rm $DOCKER_DEV_NAME-setup

  set +e
fi

# If argument 1 is provided then apply patches before build
APPLYPATCHES=$1

echo "Starting Container..."

docker run -it \
  --rm \
  -v $PWD:/share \
  -v $HOME/.ccache:/.ccache \
  -e APPLYPATCHES=$APPLYPATCHES \
  -e CCACHE_DIR=/.ccache \
  -e UID=$(id -u) \
  -e GID=$(id -g) \
  -e USERNAME=$(whoami) \
  -e GROUPNAME=$(id -gn) \
  $DOCKER_DEV_NAME \
  env MOZ_NOSPAM=1 /share/build-scripts/linux/build_basilisk_subscripts/run_inside_docker.sh
