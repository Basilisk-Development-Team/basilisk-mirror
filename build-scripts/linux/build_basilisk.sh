#!/bin/sh

if [ ! $(which docker) ]; then
    echo "Docker must be installed to run this script."
    exit
fi

if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
    echo "This script is only meant to be run on Linux or macOS."
    exit
fi

# This probably isn't the best way to determine if we are in the Basilisk root directory but it works for now.
if [ ! -f aclocal.m4 ]; then
    echo "This script must be ran from the root of the Basilisk codebase."
    exit
fi

DOCKER_DEV_NAME="basilisk_builder"
d=$(docker images -f reference="$DOCKER_DEV_NAME" --format '{{.ID}}' | wc -l)

if [ $d -eq 0 ]; then
  set -e

  if docker ps -a --format '{{.Names}}' | grep -q "^${DOCKER_DEV_NAME}-setup$"; then
      docker rm $DOCKER_DEV_NAME-setup
  fi

  docker pull oraclelinux:8

  docker run -t \
    -v $PWD:/share \
    --name $DOCKER_DEV_NAME-setup \
    oraclelinux:8 \
    env SETUP_BUILD_IMAGE=1 /share/build-scripts/linux/build_basilisk_subscripts/run_inside_docker.sh

  docker commit $DOCKER_DEV_NAME-setup $DOCKER_DEV_NAME

  if docker ps -a --format '{{.Names}}' | grep -q "^${DOCKER_DEV_NAME}-setup$"; then
      docker rm $DOCKER_DEV_NAME-setup
  fi

  set +e
fi

# If argument 1 is provided then apply patches before build
APPLYPATCHES=$1

echo "Starting Container..."

docker run -t \
  --rm \
  -v $PWD:/share \
  -e APPLYPATCHES=$APPLYPATCHES \
  -e CCACHE_DIR=/.ccache \
  -e UID=$(id -u) \
  -e GID=$(id -g) \
  -e USERNAME=$(whoami) \
  -e GROUPNAME=$(id -gn) \
  $DOCKER_DEV_NAME \
  env MOZ_NOSPAM=1 /share/build-scripts/linux/build_basilisk_subscripts/run_inside_docker.sh
