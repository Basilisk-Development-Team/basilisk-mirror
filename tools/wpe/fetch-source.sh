#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
# Optional manual preparation; mach build uses the same pinned-source helper.
# Configure never downloads dependencies.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
deps="$root/build-wpe-deps"
archive="$deps/downloads/wpewebkit-2.54.0.tar.xz"
python3 "$root/tools/wpe/prepare-source.py" \
    --source "$deps/wpewebkit-2.54.0" --archive "$archive"
printf 'WPE source: %s\n' "$deps/wpewebkit-2.54.0"
