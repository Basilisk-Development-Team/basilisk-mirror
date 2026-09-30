# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
def main(output, source):
    with open(source) as stream:
        text = stream.read()
    if ')LEGACY"' in text:
        raise ValueError('Raw C++ string delimiter in runtime source')
    output.write('R"LEGACY(' + text + ')LEGACY"\n')
