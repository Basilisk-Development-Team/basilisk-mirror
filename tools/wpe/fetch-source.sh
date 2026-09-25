#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
# Explicit developer action only. Configure never downloads dependencies.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
deps="$root/build-wpe-deps"
archive="$deps/downloads/wpewebkit-2.54.0.tar.xz"
mkdir -p "$deps/downloads"
if test ! -f "$archive"; then
    curl --fail --location https://wpewebkit.org/releases/wpewebkit-2.54.0.tar.xz \
        --output "$archive.part"
    mv "$archive.part" "$archive"
fi
printf '%s  %s\n' efa9bcc3cb891c2d88f50eec710d9ccee71cbdf1040420361eb98c17355eb452 "$archive" | sha256sum -c -
if test ! -d "$deps/wpewebkit-2.54.0"; then
    tar -xf "$archive" -C "$deps"
fi
printf 'WPE source: %s\n' "$deps/wpewebkit-2.54.0"
