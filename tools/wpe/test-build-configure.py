#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Exercise the actual application configure rules without an installed WPE.

Run with OBJDIR/_virtualenv/bin/python tools/wpe/test-build-configure.py.
Only the platform's already-resolved inputs and pkg-config output are fixtures.
"""
import logging
from io import StringIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from mozbuild.configure import ConfigureSandbox

root = Path(__file__).resolve().parents[2]
source = (root / 'basilisk/moz.configure').read_text()
rules = source[source.index("option('--enable-webkit'"):]
with TemporaryDirectory(prefix='wpe-build-configure-') as temporary:
    base = Path(temporary)
    calls = base / 'pkg-config.calls'
    pkg = base / 'pkg-config'
    pkg.write_text('#!' + sys.executable + '\n' + '''
import sys
with open(%r, 'a') as output:
    output.write(' '.join(sys.argv[1:]) + '\\n')
if '--cflags' in sys.argv: print('-I/system/include')
if '--libs' in sys.argv: print('-lsystem')
if '--modversion' in sys.argv: print('1.28.1')
''' % str(calls))
    pkg.chmod(0o755)
    fixture_source = base / 'source'
    host_tools = fixture_source / 'build-wpe-deps/prefix/bin'
    host_tools.mkdir(parents=True)
    for name in ('cmake', 'ninja', 'gperf', 'unifdef', 'meson'):
        tool = host_tools / name
        tool.write_text('#!/bin/sh\nexit 99\n')
        tool.chmod(0o755)
    prefix = base / 'prebuilt'
    for name in ('lib64/pkgconfig/wpe-webkit-2.0.pc', 'lib64/pkgconfig/wpe-platform-2.0.pc',
                 'libexec/wpe-webkit-2.0/WPEWebProcess'):
        path = prefix / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    cases = [
        ('disabled', ['--disable-webkit'], 'Linux', 'GNU', None),
        ('disabled with missing prefix', ['--disable-webkit', '--with-wpe-runtime=' + str(base / 'missing')], 'Linux', 'GNU', None),
        ('managed clean', ['--enable-webkit'], 'Linux', 'GNU', None),
        ('explicit prebuilt', ['--enable-webkit', '--with-wpe-runtime=' + str(prefix)], 'Linux', 'GNU', None),
        ('missing prebuilt', ['--enable-webkit', '--with-wpe-runtime=' + str(base / 'missing')], 'Linux', 'GNU', 'Missing'),
        ('Windows enabled', ['--enable-webkit'], 'WINNT', 'WINNT', 'Windows'),
        ('cross build', ['--enable-webkit'], 'Linux', 'GNU', 'native build'),
    ]
    for label, options, kernel, os_name, error in cases:
        calls.unlink(missing_ok=True)
        path = base / 'moz.configure'
        path.write_text('''
option('--with-external-source-dir', nargs=1, help='Fixture external source')
@depends('--help')
def toolkit(_):
    return 'gtk3'
@depends('--help')
def target(_):
    return namespace(os=%r, kernel=%r, cpu=%r)
@depends('--help')
def host(_):
    return namespace(os='GNU', kernel='Linux', cpu='loongarch64')
@depends('--help')
def check_build_environment(_):
    return namespace(topsrcdir=%r, topobjdir=%r)
@depends('--help')
def pkg_config(_):
    return %r
''' % (os_name, kernel, 'x86_64' if label == 'cross build' else 'loongarch64',
       str(fixture_source), str(base / 'obj'), str(pkg)) + rules)
        config, output = {}, StringIO()
        logger = logging.Logger(label)
        logger.addHandler(logging.StreamHandler(output))
        sandbox = ConfigureSandbox(config, {}, ['configure'] + options, output, output, logger=logger)
        sandbox.include_file(str(root / 'platform/build/moz.configure/util.configure'))
        sandbox.include_file(str(root / 'platform/build/moz.configure/checks.configure'))
        try:
            sandbox.run(str(path))
        except SystemExit:
            assert error and error in output.getvalue(), (label, output.getvalue())
        else:
            assert not error, label
            if label.startswith('disabled'):
                assert not calls.exists(), 'Disabled build probed WPE dependencies'
                assert not config.get('WPE_BUILD_FROM_SOURCE')
                assert not config.get('WPE_RUNTIME_PREFIX')
            elif label == 'managed clean':
                assert config['WPE_BUILD_FROM_SOURCE'] is True
                assert config['WPE_INTERPRETER'] is True
                assert config['WPE_RUNTIME_PREFIX'] == str(base / 'obj/webkit/stage/usr')
                assert not (base / 'obj').exists(), 'Configure built or fetched WPE'
                assert 'wpe-webkit-2.0' not in calls.read_text()
                assert 'wpe-platform-2.0' not in calls.read_text()
                assert '-lWPEWebKit-2.0' in config['WPE_WEBKIT_LIBS']
            else:
                assert not config.get('WPE_BUILD_FROM_SOURCE')
                assert config['WPE_RUNTIME_PREFIX'] == str(prefix)
                assert 'wpe-webkit-2.0' in calls.read_text()
        print('PASS:', label)
