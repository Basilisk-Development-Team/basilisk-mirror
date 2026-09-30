#!/usr/bin/env python3
"""Audit a copied application bundle, not a symlinked object distribution.

System libraries may live only in Apple's dyld shared cache. This checks their
install-name roots, not filesystem existence. Launch tests must accompany it.
"""
import argparse,re,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);args=p.parse_args()
root=args.app.resolve();main=root/'Contents/MacOS'
assert main.is_dir(),root
images=[]
for path in root.rglob('*'):
    if path.is_symlink():
        assert path.resolve().is_relative_to(root),'External symlink: '+str(path)
    if not path.is_file():continue
    with path.open('rb') as stream:magic=stream.read(4)
    if magic in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'):
        images.append(path)
def output(*args):return subprocess.check_output(args,text=True)
def system(name):return name.startswith(('/System/Library/','/usr/lib/'))
def expand(name,loader,exe):
    return Path(name.replace('@loader_path',str(loader)).replace('@executable_path',str(exe)))
main_rpaths=[]
for image in images:
    if image.name=='basilisk':
        main_rpaths=re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset',output('otool','-l',str(image)))
for image in images:
    # Packaging can preserve dependency paths yet invalidate arm64 execution
    # by stripping an already signed binary. Check that independently.
    subprocess.run(['codesign','--verify',str(image)],check=True)
    commands=output('otool','-l',str(image))
    executable='EXECUTE' in output('otool','-hv',str(image))
    exe=image.parent if executable else main
    rpaths=re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset',commands)
    for value in rpaths:
        assert value.startswith(('@loader_path','@executable_path')) or system(value),'Nonrelocatable rpath: '+value
    own=re.search(r'cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.*?) \(offset',commands)
    own=own.group(1) if own else None
    if own:
        assert own.startswith(('@rpath/','@loader_path/','@executable_path/')) or system(own),'Nonrelocatable dylib identity: '+own
    for index,line in enumerate(output('otool','-L',str(image)).splitlines()[1:]):
        name=line.strip().split(' (compatibility version')[0]
        # otool -L includes LC_ID_DYLIB first. This names the image itself;
        # unlike LC_LOAD_DYLIB it is not a dependency to resolve via rpaths.
        if index==0 and name==own:continue
        if system(name):continue
        candidates=[]
        if name.startswith('@rpath/'):
            for entry in rpaths+main_rpaths:
                candidates.append(expand(entry,image.parent,exe)/name[len('@rpath/'):])
        elif name.startswith(('@loader_path/','@executable_path/')):
            candidates.append(expand(name,image.parent,exe))
        else:raise AssertionError('Nonrelocatable dependency: %s: %s'%(image,name))
        # Unchanged UXP's GeckoChildProcessHost sets DYLD_LIBRARY_PATH to
        # the relocated GRE directory for this nested helper. It does not
        # depend on a developer shell's environment or the object directory.
        if image==main/'plugin-container.app/Contents/MacOS/plugin-container':
            candidates.append(main/Path(name).name)
        assert any(path.is_file() and path.resolve().is_relative_to(root) for path in candidates),'Unresolved bundled dependency: %s: %s'%(image,name)
print('PASS copied bundle: %d Mach-O files, no external symlinks or non-system absolute dependencies'%len(images))
