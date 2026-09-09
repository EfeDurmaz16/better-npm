#!/usr/bin/env python3
"""Local synthetic multi-project native install evidence; Python 3.9+, POSIX."""
import argparse
import base64
import concurrent.futures
import gzip
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time


def archive(name, version, size):
    # Deterministic incompressible payload avoids measuring only zero compression.
    payload = b''.join(hashlib.sha256(str(i).encode()).digest() for i in range((size + 31) // 32))[:size]
    files = {'package.json': json.dumps({'name': name, 'version': version, 'main': 'index.js'}).encode(),
             'index.js': f'module.exports = "{name}@{version}";\n'.encode(), 'payload.bin': payload}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        for name, data in files.items():
            entry = tarfile.TarInfo('package/' + name)
            entry.size = len(data)
            entry.mode = 0o644
            tar.addfile(entry, io.BytesIO(data))
    return gzip.compress(buf.getvalue(), mtime=0), files


class Registry(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, blobs, delay):
        self.blobs, self.delay = blobs, delay
        self.lock = threading.Lock()
        self.reset()
        super().__init__(('127.0.0.1', 0), Handler)

    def reset(self):
        self.requests = self.bytes_sent = self.active = self.peak = 0

    def stats(self):
        with self.lock:
            return {'requests': self.requests, 'response_body_bytes': self.bytes_sent, 'peak_active_requests': self.peak}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        server = self.server
        with server.lock:
            server.requests += 1
            server.active += 1
            server.peak = max(server.peak, server.active)
        try:
            time.sleep(server.delay)
            data = server.blobs.get(self.path)
            self.send_response(200 if data is not None else 404)
            self.send_header('Content-Length', str(len(data or b'')))
            self.end_headers()
            if data:
                self.wfile.write(data)
                with server.lock:
                    server.bytes_sent += len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with server.lock:
                server.active -= 1

    def log_message(self, *_):
        pass


def disk_usage(root):
    logical = allocated = 0
    inodes = set()
    for path in root.rglob('*'):
        st = path.lstat()
        key = (st.st_dev, st.st_ino)
        if path.is_file() and not path.is_symlink():
            logical += st.st_size
        if key not in inodes:
            allocated += getattr(st, 'st_blocks', 0) * 512
            inodes.add(key)
    return {'file_logical_bytes': logical, 'inode_deduplicated_stat_blocks_bytes': allocated}


def install(binary, project, cache, env, jobs, timeout):
    command = [str(binary), 'install', '--project-root', str(project), '--cache-root', str(cache),
               '--no-scripts', '--hoist', '--jobs', str(jobs)]
    start = time.monotonic()
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(command, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        timed_out = False
        while True:
            pid, status, usage = os.wait4(process.pid, os.WNOHANG)
            if pid:
                break
            if time.monotonic() - start > timeout:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                _, status, usage = os.wait4(process.pid, 0)
                break
            time.sleep(0.01)
        process.returncode = os.waitstatus_to_exitcode(status)
        stdout.seek(0)
        stderr.seek(0)
        return {'exit_code': process.returncode, 'timed_out': timed_out,
                'wall_ms': round((time.monotonic() - start) * 1000, 3),
                'user_cpu_seconds': usage.ru_utime, 'system_cpu_seconds': usage.ru_stime,
                'child_max_rss_bytes': usage.ru_maxrss * (1 if platform.system() == 'Darwin' else 1024),
                'stdout_tail': stdout.read()[-4096:].decode(errors='replace'),
                'stderr_tail': stderr.read()[-4096:].decode(errors='replace')}


def write_project(project, packages, url, changed=False):
    project.mkdir(parents=True, exist_ok=True)
    dependencies, entries = {}, {}
    for name, versions in packages.items():
        version = '2.0.0' if changed and name == 'fixture-0' else '1.0.0'
        blob, _ = versions[version]
        dependencies[name] = version
        entries['node_modules/' + name] = {'name': name, 'version': version,
            'resolved': f'{url}/{name}-{version}.tgz',
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(blob).digest()).decode()}
    manifest = {'name': 'worktree-fixture', 'version': '1.0.0', 'dependencies': dependencies}
    (project / 'package.json').write_text(json.dumps(manifest))
    (project / 'package-lock.json').write_text(json.dumps({'name': manifest['name'], 'version': '1.0.0',
        'lockfileVersion': 3, 'packages': {'': manifest, **entries}}))


def validate(project, packages, changed=False):
    errors = []
    for name, versions in packages.items():
        version = '2.0.0' if changed and name == 'fixture-0' else '1.0.0'
        for filename, expected in versions[version][1].items():
            path = project / 'node_modules' / name / filename
            if not path.is_file() or path.read_bytes() != expected:
                errors.append(f'{name}/{filename}: missing or incorrect content')
    actual = {p.name for p in (project / 'node_modules').glob('*') if not p.name.startswith('.')}
    if actual != set(packages):
        errors.append('package inventory mismatch')
    return errors


def cohort(args, root, count, packages, registry):
    cache = root / 'cache'
    home = root / 'home'
    home.mkdir(parents=True)
    # No user npm configuration, registry tokens or credentials enter fixtures.
    env = {key: value for key, value in os.environ.items()
           if key in ('PATH', 'SYSTEMROOT', 'TMPDIR', 'LANG')}
    env.update(HOME=str(home), XDG_CACHE_HOME=str(home / '.cache'))
    projects = [root / f'project-{i}' for i in range(count)]
    url = f'http://127.0.0.1:{registry.server_port}'
    reports = []
    for scenario in ('cold', 'warm', 'change', 'recovery'):
        changed = scenario in ('change', 'recovery')
        for project in projects:
            write_project(project, packages, url, changed)
            if scenario == 'warm':
                shutil.rmtree(project / 'node_modules', ignore_errors=True)
            if scenario == 'recovery':
                shutil.rmtree(project / 'node_modules' / 'fixture-0', ignore_errors=True)
        registry.reset()
        before = disk_usage(root)
        start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            children = list(pool.map(lambda p: install(args.binary, p, cache, env, args.jobs, args.timeout), projects))
        wall = (time.monotonic() - start) * 1000
        checks = [validate(project, packages, changed) for project in projects]
        ok = all(child['exit_code'] == 0 for child in children) and not any(checks)
        reports.append({'scenario': scenario, 'workers': count, 'ok': ok,
            'cohort_wall_ms': round(wall, 3), 'child_cpu_seconds_sum': sum(c['user_cpu_seconds'] + c['system_cpu_seconds'] for c in children),
            'largest_child_max_rss_bytes': max(c['child_max_rss_bytes'] for c in children),
            'aggregate_peak_rss_bytes': None, 'disk_write_bytes': None, 'swap_bytes': None,
            'http': registry.stats(), 'disk_before': before, 'disk_after': disk_usage(root),
            'children': children, 'validation_errors': checks})
        if not ok:
            return reports
    # In-place write catches hardlink contamination, unlike unlink-and-replace.
    victim = projects[0] / 'node_modules' / 'fixture-0' / 'index.js'
    victim.write_text('mutation isolation probe\n')
    errors = [error for project in projects[1:] for error in validate(project, packages, True)]
    fresh = root / 'isolation-fresh'
    write_project(fresh, packages, url, True)
    child = install(args.binary, fresh, cache, env, args.jobs, args.timeout)
    errors.extend(validate(fresh, packages, True))
    reports.append({'scenario': 'mutation_isolation', 'workers': count,
                    'ok': child['exit_code'] == 0 and not errors, 'validation_errors': errors, 'child': child})
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--workers', default='1')
    parser.add_argument('--rounds', type=int, default=1)
    parser.add_argument('--packages', type=int, default=4)
    parser.add_argument('--payload-kib', type=int, default=64)
    parser.add_argument('--delay-ms', type=int, default=0)
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        workers = [int(n) for n in args.workers.split(',')]
    except ValueError:
        parser.error('--workers must be comma-separated integers')
    if not workers or any(n < 1 or n > 100 for n in workers) or min(args.rounds, args.packages, args.jobs) < 1 or args.payload_kib < 0 or args.delay_ms < 0 or args.timeout <= 0:
        parser.error('invalid count, size, delay or timeout')
    args.binary = args.binary.resolve()
    if not args.binary.is_file() or not os.access(args.binary, os.X_OK):
        parser.error('--binary must name an executable')
    if not hasattr(os, 'wait4') or platform.system() not in ('Darwin', 'Linux'):
        parser.error('resource accounting currently requires macOS or Linux')
    packages = {f'fixture-{i}': {v: archive(f'fixture-{i}', v, args.payload_kib * 1024)
                for v in ('1.0.0', '2.0.0')} for i in range(args.packages)}
    blobs = {f'/{name}-{version}.tgz': data[0] for name, versions in packages.items() for version, data in versions.items()}
    registry = Registry(blobs, args.delay_ms / 1000)
    threading.Thread(target=registry.serve_forever, daemon=True).start()
    report = {'schema_version': 1, 'platform': platform.platform(), 'binary': str(args.binary),
        'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        'configuration': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        'measurement_notes': ['Native install only; no npm comparison or speedup ratio.',
            'CPU sums child usage; excludes Python coordinator and localhost server.',
            'RSS is largest single child high-water mark, not simultaneous cohort peak.',
            'stat blocks deduplicates hardlink inodes, not shared clone extents; not unique physical disk usage.',
            'OS page cache is uncontrolled. Warm removes node_modules but retains installer metadata and shared cache.',
            'Synthetic flat packages with scripts disabled; not application or Cargo build evidence.'], 'runs': []}
    try:
        with tempfile.TemporaryDirectory(prefix='better-worktrees-') as tmp:
            for count in workers:
                for round_index in range(args.rounds):
                    entries = cohort(args, Path(tmp) / f'w{count}-r{round_index}', count, packages, registry)
                    report['runs'].append({'round': round_index + 1, 'workers': count, 'scenarios': entries})
    finally:
        registry.shutdown()
        registry.server_close()
    report['ok'] = all(s['ok'] for run in report['runs'] for s in run['scenarios'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'ok': report['ok'], 'output': str(args.output.resolve())}))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
