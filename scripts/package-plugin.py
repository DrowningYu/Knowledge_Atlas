#!/usr/bin/env python3
"""Build a desktop ZIP, or a cloud ZIP bound to the user's registered MCP app."""
import argparse
import json
import pathlib
import re
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app-id', help='Actual plugin_asdk_app... ID from your registered ChatGPT tunnel connection')
parser.add_argument('--output', type=pathlib.Path, help='Destination ZIP (default: artifacts/plugins/)')
args = parser.parse_args()
if args.app_id and not re.fullmatch(r'plugin_asdk_app_[A-Za-z0-9_-]+', args.app_id):
    parser.error('--app-id must be the actual registered plugin_asdk_app... ID, not a URL or a tunnel ID')
source = root / 'plugins/knowledge-atlas'
manifest = json.loads((source / 'plugin.json').read_text())
mode = 'chatgpt' if args.app_id else 'desktop'
output = args.output or root / 'artifacts/plugins' / f'knowledge-atlas-{mode}-{manifest["version"]}.zip'
package_files = ['plugin.json', 'mcp.json', 'README.md', 'server/stdio.mjs', 'skills/knowledge-atlas/SKILL.md', 'assets/icon.png']
entries = {name: (source / name).read_bytes() for name in package_files}
if args.app_id:
    # Cloud chats call the already registered connection; local execution is not claimed.
    entries = {k:v for k,v in entries.items() if k != 'mcp.json' and not k.startswith('server/')}
    manifest['extensions']['com.openai']['apps'] = './.app.json'
    manifest['extensions']['com.openai']['interface']['longDescription'] = '通过已注册的 ChatGPT MCP 连接读取和更新 Knowledge Atlas。使用前保持 Knowledge Atlas 和安全隧道运行。'
    entries['.app.json'] = json.dumps({'apps': {'knowledge-atlas': {'id': args.app_id, 'required': True}}}, indent=2).encode()
entries['plugin.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, content in sorted(entries.items()):
        info = zipfile.ZipInfo(name, (2026, 11, 12, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, content)
print(f'Created {output} ({mode}; {len(entries)} files)')
