#!/usr/bin/env python3
"""Verify the final DMG layout, sealed app and native startup on a disposable macOS CI runner."""
import hashlib
import json
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request

assert sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true', 'Use a disposable GitHub macOS runner'
dmg = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path('artifacts/ci').resolve()
out.mkdir(parents=True, exist_ok=True)
def record_failure(kind, value, tb):
    details = ''.join(traceback.format_exception(kind, value, tb))
    (out / 'macos-failure.txt').write_text(details)
    sys.__excepthook__(kind, value, tb)
sys.excepthook = record_failure

def run(*args, check=True):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stdout}')
    return result

run('hdiutil', 'verify', str(dmg))
mounted = plistlib.loads(subprocess.check_output(['hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', str(dmg)]))
volume = pathlib.Path(next(e['mount-point'] for e in mounted['system-entities'] if 'mount-point' in e))
proc = None
try:
    app = volume / 'Knowledge Atlas.app'
    assert (volume / 'Applications').is_symlink()
    assert os.readlink(volume / 'Applications') == '/Applications'
    assert (volume / '.DS_Store').stat().st_size > 0
    expected = pathlib.Path('src-tauri/dmg/background.png').read_bytes()
    backgrounds = [p for p in (volume / '.background').rglob('*') if p.is_file()]
    assert any(p.read_bytes() == expected for p in backgrounds), 'Background missing or different'
    with (app / 'Contents/Info.plist').open('rb') as f:
        info = plistlib.load(f)
    assert info['CFBundleShortVersionString'] == json.loads(pathlib.Path('package.json').read_text())['version']
    runtime = app / 'Contents/MacOS/tunnel-client-runtime'
    assert runtime.is_file(), 'Bundled tunnel runtime missing'
    assert '0.0.20' in run(str(runtime), '--version').stdout
    signature = run('codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)).stdout
    (out / 'macos-signature.txt').write_text(signature + run('codesign', '-d', '--verbose=4', str(app)).stdout)
    # Ad-hoc signing seals resources, but is NOT Apple Developer ID notarization.
    assessment = run('spctl', '--assess', '--type', 'execute', '--verbose=4', str(app), check=False)
    (out / 'macos-gatekeeper.txt').write_text(f'exit={assessment.returncode}\n' + assessment.stdout)
    finder = '''tell application "Finder"
      activate
      open (POSIX file "%s" as alias)
      delay 2
      set diskFolder to (POSIX file "%s" as alias)
      set installWindow to container window of diskFolder
      if current view of installWindow is not icon view then error "DMG is not in icon view"
      set a to position of item "Knowledge Atlas.app" of diskFolder
      set b to position of item "Applications" of diskFolder
      if item 1 of a is not 180 or item 2 of a is not 170 then error "App icon misplaced"
      if item 1 of b is not 480 or item 2 of b is not 170 then error "Applications icon misplaced"
      return {a, b}
    end tell''' % (volume, volume)
    # Finder may reject its background-picture getter for read-only disks (-10000).
    # Background bytes are verified above; the actual rendered window is captured below.
    layout_result = run('osascript', '-e', finder, check=False)
    (out / 'macos-layout.txt').write_text(layout_result.stdout)
    run('screencapture', '-x', str(out / 'macos-dmg.png'))
    # Copy out of the disk image just as drag-to-Applications would, then recheck the copy.
    installed = pathlib.Path(tempfile.mkdtemp(prefix='atlas-installed-')) / app.name
    run('ditto', str(app), str(installed))
    run('codesign', '--verify', '--deep', '--strict', str(installed))
    data = pathlib.Path.home() / 'Library/Application Support/app.knowledgeatlas.desktop'
    assert not data.exists(), 'Runner already has user data; refusing to reuse it'
    with (out / 'macos-startup.txt').open('w') as log:
        proc = subprocess.Popen(['open', '-n', '-W', str(installed)], stdout=log, stderr=log)
        deadline = time.monotonic() + 60
        graph = None
        while time.monotonic() < deadline:
            try:
                token = (data / 'mcp.token').read_text().strip()
                req = urllib.request.Request('http://127.0.0.1:38473/api', data=json.dumps({'method':'get_map','params':{'map_id':'pid-control'}}).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
                with urllib.request.urlopen(req, timeout=2) as response:
                    graph = json.load(response)
                if len(graph['nodes']) == 21:
                    break
            except (OSError, KeyError, ValueError):
                pass
            time.sleep(1)
        assert graph and len(graph['nodes']) == 21, 'Packaged app failed to start its real backend'
        time.sleep(5)
        assert proc.poll() is None, 'Native app exited unexpectedly'
        run('screencapture', '-x', str(out / 'macos-app.png'))
        (out / 'macos-result.json').write_text(json.dumps({'version':info['CFBundleShortVersionString'],'dmg_sha256':hashlib.sha256(dmg.read_bytes()).hexdigest(),'sealed_signature':True,'finder_layout':layout_result.returncode == 0,'native_startup':True,'demo_nodes':len(graph['nodes']),'gatekeeper_exit':assessment.returncode,'notarized':False}, indent=2))
    assert layout_result.returncode == 0, layout_result.stdout
    print('DMG integrity, arrow layout, app signature, installed copy and native startup passed')
finally:
    if proc is not None:
        run('osascript', '-e', 'tell application "Knowledge Atlas" to quit', check=False)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.terminate()
    run('hdiutil', 'detach', str(volume), check=False)
