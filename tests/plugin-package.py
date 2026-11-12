import json
import pathlib
import subprocess
import tempfile
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
    for app_id in [None, 'plugin_asdk_app_test_fixture']:
        out = pathlib.Path(temp) / ('cloud.zip' if app_id else 'desktop.zip')
        command = [sys.executable, str(root / 'scripts/package-plugin.py'), '--output', str(out)]
        if app_id: command += ['--app-id', app_id]
        subprocess.run(command, check=True)
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            assert 'plugin.json' in names and 'skills/knowledge-atlas/SKILL.md' in names
            assert all(not n.startswith('/') and '..' not in pathlib.PurePosixPath(n).parts for n in names)
            assert not any(n.endswith(('.token', '.sqlite', '.db', '.env')) for n in names)
            manifest = json.loads(z.read('plugin.json'))
            assert manifest['name'] == 'knowledge-atlas'
            if app_id:
                assert 'mcp.json' not in names and not any(n.startswith('server/') for n in names)
                assert manifest['extensions']['com.openai']['apps'] == './.app.json'
                assert json.loads(z.read('.app.json'))['apps']['knowledge-atlas']['id'] == app_id
            else:
                assert '.app.json' not in names and 'server/stdio.mjs' in names
                assert json.loads(z.read('mcp.json'))['mcpServers']['knowledge-atlas']['type'] == 'stdio'
        # Deterministic packaging; no user data or build-clock noise.
        before = out.read_bytes()
        subprocess.run(command, check=True)
        assert before == out.read_bytes()
    bad = subprocess.run([sys.executable, str(root / 'scripts/package-plugin.py'), '--app-id', 'https://wrong.example/'], capture_output=True)
    assert bad.returncode != 0
print('PASS: desktop and account-bound cloud ZIP layouts, no credential files, deterministic output, invalid binding rejected')
