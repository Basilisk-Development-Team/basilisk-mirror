#!/usr/bin/env python3
"""Audit an explicitly disabled macOS distribution, including every Mach-O."""
import argparse,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('objdir',type=Path);a=p.parse_args();obj=a.objdir.resolve()
config=(obj/'mozilla-config.h').read_text()
assert '#define MOZ_WEBKIT' not in config,'MOZ_WEBKIT remains defined'
root=obj/'dist/Basilisk.app';assert root.is_dir(),root
count=0;seen=set()
for file in root.rglob('*'):
 if not file.is_file():continue
 actual=file.resolve()
 if actual in seen:continue
 seen.add(actual)
 assert file.name not in ('webcontentview.xpt','ContentEngineDownload.jsm','LegacyBlockingExtensions.jsm','LegacyXULContentCompatibility.jsm'),str(file)
 assert 'contentengine' not in file.parts,str(file)
 with actual.open('rb') as f:magic=f.read(4)
 if magic not in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'):continue
 count+=1
 deps=subprocess.check_output(['otool','-L',str(actual)],text=True).splitlines()[1:]
 for line in deps:
  assert not any(s in line.lower() for s in ('webkit.framework','wpe','javascriptcore.framework')),line
print('PASS disabled macOS build: %d Mach-O files; no WebKit/WPE linkage, component or content-engine resources'%count)
