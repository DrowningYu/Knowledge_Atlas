#!/usr/bin/env python3
"""Fetch the pinned official runtime for the installer target; verify before extraction."""
import hashlib, io, pathlib, sys, urllib.request, zipfile
TARGETS = {
 'x86_64-unknown-linux-gnu': ('linux-amd64', '05f4d211ce41cfb69a9c520daaad188c80f61d8e6e2db204e20efea50d474d3c'),
 'x86_64-pc-windows-msvc': ('windows-amd64', 'cc726a615620043895ba6cdedb6ca7c624f5b0bfe85dbb4de234f6412846554e'),
 'x86_64-apple-darwin': ('darwin-amd64', '54c2abb93e33fa0012fba34d1d3906536b9336b7f00b5e6ebb6b8fe77ac4b7a7'),
 'aarch64-apple-darwin': ('darwin-arm64', '8fb6a29fd777b867a3a379bf3264157debf61cb5f487c07a0dcaea1c5b6e6670'),
}
root = pathlib.Path(__file__).resolve().parents[1]
target = sys.argv[1]
platform, digest = TARGETS[target]
version = 'v0.0.20'
name = f'tunnel-client-runtime-{version}-{platform}'
data = urllib.request.urlopen(f'https://github.com/openai/tunnel-client/releases/download/{version}/{name}.zip', timeout=90).read()
assert hashlib.sha256(data).hexdigest() == digest, 'Runtime download checksum mismatch'
ext = '.exe' if 'windows' in platform else ''
binary = root / 'src-tauri/binaries' / f'tunnel-client-runtime-{target}{ext}'
binary.parent.mkdir(parents=True, exist_ok=True)
licenses = root / 'src-tauri/resources/tunnel'
licenses.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
 binary.write_bytes(archive.read('tunnel-client-runtime' + ext))
 binary.chmod(0o755)
 for f in ['LICENSE', 'NOTICE', name + '-licenses.txt']:
  (licenses / ('THIRD-PARTY.txt' if f.endswith('-licenses.txt') else f)).write_bytes(archive.read(f))
print('Prepared verified OpenAI tunnel runtime', version, target)
