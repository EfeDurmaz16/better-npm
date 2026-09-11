#!/usr/bin/env python3
"""Paired native install diagnostic and separate candidate default-policy evidence.

Only the diagnostic disables firewall, in temporary fixtures. The exact baseline
has no local security registry override. Never label diagnostic speedups as
production default-policy speedups. Python stdlib only, macOS/Linux.
"""
import argparse
import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile
import threading
import time
import worktrees as common


class Registry(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, packages, delay):
        self.packages = packages
        self.delay = delay
        self.lock = threading.Lock()
        self.reset()
        super().__init__(('127.0.0.1', 0), Handler)
        self.blobs = {f'/{name}-{version}.tgz': item[0]
                      for name, versions in packages.items() for version, item in versions.items()}
        url = f'http://127.0.0.1:{self.server_port}'
        for name, versions in packages.items():
            metadata = {'name': name, 'dist-tags': {'latest': '2.0.0'},
                        'time': {v: '2020-01-01T00:00:00.000Z' for v in versions},
                        'versions': {v: {'name': name, 'version': v, 'dist': {
                            'tarball': f'{url}/{name}-{v}.tgz'}} for v in versions}}
            self.blobs['/' + name] = json.dumps(metadata).encode()

    def reset(self):
        with self.lock:
            self.routes = {}
            self.active = self.peak = self.bytes_sent = 0

    def stats(self):
        with self.lock:
            return {'routes': dict(self.routes), 'requests': sum(self.routes.values()),
                    'unknown_routes': [p for p in self.routes if p not in self.blobs],
                    'metadata_requests': sum(n for p, n in self.routes.items()
                                             if p in self.blobs and not p.endswith('.tgz')),
                    'tarball_requests': sum(n for p, n in self.routes.items() if p.endswith('.tgz')),
                    'response_body_bytes': self.bytes_sent, 'peak_active_requests': self.peak}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        server = self.server
        with server.lock:
            server.routes[self.path] = server.routes.get(self.path, 0) + 1
            server.active += 1
            server.peak = max(server.peak, server.active)
        try:
            time.sleep(server.delay)
            data = server.blobs.get(self.path)
            self.send_response(200 if data is not None else 404)
            self.send_header('Content-Type', 'application/octet-stream' if self.path.endswith('.tgz') else 'application/json')
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

    def do_POST(self):
        # Unexpected policy endpoints must fail evidence validation, not silently
        # receive a fabricated clean audit response.
        with self.server.lock:
            route = 'POST ' + self.path
            self.server.routes[route] = self.server.routes.get(route, 0) + 1
        self.send_error(404)

    def log_message(self, *_):
        pass


def cohort(args, binary, root, workers, packages, registry, default_policy):
    home, cache = root / 'home', root / 'cache'
    home.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'SYSTEMROOT', 'TMPDIR', 'LANG')}
    url = f'http://127.0.0.1:{registry.server_port}'
    env.update(HOME=str(home), XDG_CACHE_HOME=str(home / '.cache'),
               NPM_CONFIG_REGISTRY=url)
    projects = [root / f'project-{i}' for i in range(workers)]
    for project in projects:
        common.write_project(project, packages, url)
        if not default_policy:
            (project / '.better-firewall.json').write_text(json.dumps({'enabled': False}))
    reports = []
    for scenario in ('cold', 'warm', 'noop'):
        if scenario == 'warm':
            for project in projects:
                shutil.rmtree(project / 'node_modules', ignore_errors=True)
        # Noop intentionally leaves manifests, lockfiles and installed tree alone.
        registry.reset()
        before = common.disk_usage(root)
        start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            children = list(pool.map(lambda p: common.install(binary, p, cache, env,
                                                              args.jobs, args.timeout), projects))
        elapsed = (time.monotonic() - start) * 1000
        checks = [common.validate(p, packages) for p in projects]
        http = registry.stats()
        reasons = []
        if http['unknown_routes']:
            reasons.append('Unexpected registry routes')
        if default_policy and scenario == 'cold':
            missing = [name for name in packages if '/' + name not in http['routes']]
            if missing:
                reasons.append('Cold default policy did not request local metadata for: ' + ', '.join(missing))
        ok = all(c['exit_code'] == 0 and not c['timed_out'] for c in children) and not any(checks) and not reasons
        reports.append({'scenario': scenario, 'ok': ok, 'cohort_wall_ms': elapsed,
                        'child_cpu_seconds_sum': sum(c['user_cpu_seconds'] + c['system_cpu_seconds'] for c in children),
                        'largest_child_max_rss_bytes': max(c['child_max_rss_bytes'] for c in children),
                        'aggregate_peak_rss_bytes': None, 'http': http, 'children': children,
                        'disk_before': before, 'disk_after': common.disk_usage(root),
                        'validation_errors': checks, 'evidence_errors': reasons})
        if not ok:
            return reports
    # Verify in-place mutation cannot alter another worktree or the cached source.
    (projects[0] / 'node_modules/fixture-0/index.js').write_text('mutation isolation probe\n')
    errors = [e for project in projects[1:] for e in common.validate(project, packages)]
    fresh = root / 'isolation-fresh'
    common.write_project(fresh, packages, url)
    if not default_policy:
        (fresh / '.better-firewall.json').write_text(json.dumps({'enabled': False}))
    child = common.install(binary, fresh, cache, env, args.jobs, args.timeout)
    errors.extend(common.validate(fresh, packages))
    reports.append({'scenario': 'mutation_isolation', 'ok': not errors and child['exit_code'] == 0,
                    'validation_errors': errors, 'child': child})
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--workers', default='1,4,20')
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--packages', type=int, default=8)
    parser.add_argument('--payload-kib', type=int, default=64)
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--delay-ms', type=float, default=0)
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--mode', choices=('diagnostic', 'candidate-default', 'all'), default='all')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        workers = [int(n) for n in args.workers.split(',')]
    except ValueError:
        parser.error('--workers must be comma-separated integers')
    if (not workers or any(n < 1 or n > 100 for n in workers) or not 1 <= args.rounds <= 20
            or not 1 <= args.packages <= 1000 or not 1 <= args.jobs <= 100
            or not 0 <= args.payload_kib <= 1024 or not 0 <= args.delay_ms <= 1000
            or not 0 < args.timeout <= 600):
        parser.error('counts, payload, delay or timeout outside bounded range')
    if not hasattr(os, 'wait4'):
        parser.error('POSIX wait4 is required')
    for name in ('baseline', 'candidate'):
        binary = getattr(args, name).resolve()
        if not binary.is_file() or not os.access(binary, os.X_OK):
            parser.error(f'--{name} must be an executable')
        setattr(args, name, binary)
    packages = {f'fixture-{i}': {v: common.archive(f'fixture-{i}', v, args.payload_kib * 1024)
                                for v in ('1.0.0', '2.0.0')} for i in range(args.packages)}
    report = {'schema_version': 1, 'platform': platform.platform(),
              'binaries': {name: {'path': str(getattr(args, name)), 'sha256': hashlib.sha256(getattr(args, name).read_bytes()).hexdigest()}
                           for name in ('baseline', 'candidate')},
              'configuration': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
              'notes': ['Paired diagnostic disables firewall in isolated fixtures; no default-policy speedup claim.',
                        'Candidate default-policy is separate, requires local metadata per package on cold install.',
                        'Fresh native CLI only; resident timings are not represented in this report.',
                        'No user configuration or credentials inherited; no scripts or provenance opt-in.',
                        'Local request counters cannot prove absence of external traffic; use OS network isolation for that guarantee.',
                        'Payload bytes differ across package names and versions; flat synthetic graph only.',
                        'Cold means empty installer cache, not dropped OS page cache; warm removes node_modules; noop leaves it.',
                        'Timing uses blocking wait4, includes native process startup; validation and disk walks excluded.',
                        'CPU sums child usage; RSS is largest child, not aggregate peak; stat blocks do not measure unique CoW extents.'],
              'runs': []}
    registry = Registry(packages, args.delay_ms / 1000)
    threading.Thread(target=registry.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='better-paired-') as tmp:
            for count in workers:
                for round_index in range(args.rounds):
                    order = ['baseline', 'candidate'] if round_index % 2 == 0 else ['candidate', 'baseline']
                    modes = [('diagnostic', name) for name in order] if args.mode != 'candidate-default' else []
                    if args.mode != 'diagnostic':
                        modes.append(('candidate-default', 'candidate'))
                    for mode, name in modes:
                        root = Path(tmp) / f'{count}-{round_index}-{mode}-{name}'
                        results = cohort(args, getattr(args, name), root, count, packages, registry,
                                         mode == 'candidate-default')
                        report['runs'].append({'mode': mode, 'engine': name, 'workers': count,
                                               'round': round_index + 1, 'scenarios': results})
                        args.output.parent.mkdir(parents=True, exist_ok=True)
                        args.output.write_text(json.dumps(report, indent=2) + '\n')
    finally:
        registry.shutdown()
        registry.server_close()
    report['ok'] = all(s['ok'] for r in report['runs'] for s in r['scenarios'])
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'ok': report['ok'], 'output': str(args.output.resolve())}))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
