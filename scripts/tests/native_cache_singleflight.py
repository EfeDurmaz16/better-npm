"""Localhost integration: one producer per digest, including process death.
Run after cargo build --manifest-path crates/Cargo.toml -p better-core.
"""
import base64
import hashlib
import http.server
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile
import threading
import time

binary = pathlib.Path(__file__).resolve().parents[2] / 'crates/target/debug/better-core'
root = pathlib.Path(tempfile.mkdtemp(prefix='better-singleflight-'))
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    body = b'{"name":"fixture","version":"1.0.0"}'
    header = tarfile.TarInfo('package/package.json')
    header.size = len(body)
    archive.addfile(header, io.BytesIO(body))
data = buffer.getvalue()
integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
counts = {}
started = threading.Event()
release = threading.Event()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        counts[self.path] = counts.get(self.path, 0) + 1
        if self.path == '/crash' and counts[self.path] == 1:
            started.set()
            release.wait(20)
        else:
            time.sleep(0.15)
        self.send_response(200)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

def launch(group, index, duplicates=1):
    project = root / group / str(index)
    project.mkdir(parents=True)
    (project / 'package.json').write_text('{"name":"test","version":"1.0.0"}')
    entries = {'': {}}
    for n in range(duplicates):
        entries[f'node_modules/fixture{n}'] = {
            'name': 'fixture', 'version': '1.0.0',
            'resolved': f'http://127.0.0.1:{server.server_port}/{group}',
            'integrity': integrity,
        }
    (project / 'package-lock.json').write_text(json.dumps({'lockfileVersion': 3, 'packages': entries}))
    return subprocess.Popen([str(binary), 'install', '--project-root', str(project),
                             '--cache-root', str(root / group / 'cache'), '--no-scripts', '--hoist'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def finish(process):
    out, err = process.communicate(timeout=90)
    assert process.returncode == 0, (out, err)
    assert json.loads(out)['ok'], out

for number in (1, 4, 20):
    group = f'processes-{number}'
    processes = [launch(group, index, duplicates=4) for index in range(number)]
    for process in processes:
        finish(process)
    assert counts['/' + group] == 1, counts
    print(json.dumps({'processes': number, 'entries_each': 4, 'gets': counts['/' + group]}), flush=True)

first = launch('crash', 0)
assert started.wait(20)
first.kill()
first.communicate(timeout=20)
second = launch('crash', 1)
finish(second)
release.set()
assert counts['/crash'] == 2, counts
print(json.dumps({'interrupted_writer_recovered': True, 'gets': counts['/crash']}), flush=True)
server.shutdown()
