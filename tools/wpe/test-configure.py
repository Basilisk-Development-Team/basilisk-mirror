#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Test WebKit's platform gate without requiring target compilers or WPE.

Run with OBJDIR/_virtualenv/bin/python tools/wpe/test-configure.py.
The real configure sandbox parses the option and evaluates the application
rule; only its already-resolved toolkit and target inputs are supplied here.
"""
import logging
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from mozbuild.configure import ConfigureSandbox

root = Path(__file__).resolve().parents[2]
source = (root / 'basilisk/moz.configure').read_text()
gate = source[source.index("option('--enable-webkit'"):
              source.index("option('--with-wpe-runtime'")]

cases = [
    ('Windows default', 'WINNT', 'WINNT', 'windows', None, None),
    ('Windows disabled', 'WINNT', 'WINNT', 'windows', '--disable-webkit', None),
    ('Windows enabled', 'WINNT', 'WINNT', 'windows', '--enable-webkit', 'Windows'),
    ('Windows forced GTK3', 'WINNT', 'WINNT', 'gtk3', '--enable-webkit', 'Windows'),
    ('Linux default', 'GNU', 'Linux', 'gtk3', None, None),
    ('Linux disabled', 'GNU', 'Linux', 'gtk3', '--disable-webkit', None),
    ('Linux GTK3 enabled', 'GNU', 'Linux', 'gtk3', '--enable-webkit', True),
    ('Linux GTK2 rejected', 'GNU', 'Linux', 'gtk2', '--enable-webkit', 'Linux and cairo-gtk3'),
    ('macOS rejected', 'OSX', 'Darwin', 'cocoa', '--enable-webkit', 'Linux and cairo-gtk3'),
]

with TemporaryDirectory(prefix='basilisk-webkit-configure-') as temporary:
    path = Path(temporary) / 'moz.configure'
    for label, os_name, kernel, toolkit, option, expected in cases:
        path.write_text("""
@depends('--help')
def toolkit(_):
    return %r

@depends('--help')
def target(_):
    return namespace(os=%r, kernel=%r)

""" % (toolkit, os_name, kernel) + gate)
        config, output = {}, StringIO()
        logger = logging.Logger(label)
        logger.addHandler(logging.StreamHandler(output))
        sandbox = ConfigureSandbox(config, {}, ['configure'] + ([option] if option else []),
                                   output, output, logger=logger)
        sandbox.include_file(str(root / 'platform/build/moz.configure/util.configure'))
        sandbox.include_file(str(root / 'platform/build/moz.configure/checks.configure'))
        try:
            sandbox.run(str(path))
        except SystemExit as error:
            assert isinstance(expected, str), (label, output.getvalue())
            assert error.code == 1 and expected in output.getvalue(), (label, output.getvalue())
        else:
            assert not isinstance(expected, str), (label, 'unsupported target accepted')
            assert config.get('MOZ_WEBKIT') is expected, (label, config)
            assert config.get('DEFINES', {}).get('MOZ_WEBKIT') is expected, (label, config)
        print('PASS:', label)
