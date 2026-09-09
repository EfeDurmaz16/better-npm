#!/usr/bin/env node
/** Fresh native CLI vs real resident completion. Fixture setup is outside timers. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const options = { workers: '1,4', rounds: '3', packages: '8', 'payload-kib': '64', jobs: '4', 'timeout-ms': '120000' };
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || argv[i + 1] == null) throw new Error('Expected --name value arguments');
  const key = argv[i].slice(2);
  if (!(key in options) && !['binary', 'output'].includes(key)) throw new Error(`Unknown option ${key}`);
  options[key] = argv[i + 1];
}
if (!options.binary || !options.output) throw new Error('--binary and --output are required');
const workers = options.workers.split(',').map(Number);
const rounds = Number(options.rounds), count = Number(options.packages), bytes = Number(options['payload-kib']) * 1024;
const jobs = Number(options.jobs), timeoutMs = Number(options['timeout-ms']);
if (workers.some(n => !Number.isInteger(n) || n < 1 || n > 20) || !Number.isInteger(rounds) || rounds < 1 || rounds > 10 || !Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(bytes) || bytes < 0 || bytes > 1024 * 1024 || !Number.isInteger(jobs) || jobs < 1 || jobs > 32 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid bounded fixture parameters');
const binary = path.resolve(options.binary), output = path.resolve(options.output);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'better-resident-bench-'));
const home = path.join(tmp, 'home');
await fs.mkdir(home);
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, '.cache');
for (const key of Object.keys(process.env)) {
  if (/^(npm_config_|better_|node_options$|node_path$)/i.test(key)) delete process.env[key];
}
// Defense in depth for clients respecting proxy environment. This is not an OS
// network sandbox; local counters alone cannot prove absence of outside traffic.
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = process.env.ALL_PROXY = 'http://127.0.0.1:9';
process.env.NO_PROXY = '127.0.0.1,localhost';
const digest = (data, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
function tar(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    const octal = (offset, width, n) => header.write(n.toString(8).padStart(width - 1, '0') + '\0', offset, width);
    octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const packages = Array.from({ length: count }, (_, i) => {
  const name = `fixture-${i}`, version = '1.0.0';
  const payload = Buffer.concat(Array.from({ length: Math.ceil(bytes / 32) }, (_, n) => createHash('sha256').update(`${name}@${version}:${n}`).digest())).subarray(0, bytes);
  const files = { 'package.json': Buffer.from(JSON.stringify({ name, version, main: 'index.js' })), 'index.js': Buffer.from(`module.exports = "${name}@${version}";\n`), 'payload.bin': payload };
  return { name, version, files, blob: tar(files) };
});
let routes = {}, unknown = [];
const server = http.createServer((req, res) => {
  const route = `${req.method} ${req.url}`;
  routes[route] = (routes[route] || 0) + 1;
  const item = packages.find(p => req.url === `/${p.name}` || req.url === `/${p.name}-${p.version}.tgz`);
  if (req.method !== 'GET' || !item) { unknown.push(route); res.writeHead(404); res.end(); return; }
  const body = req.url.endsWith('.tgz') ? item.blob : Buffer.from(JSON.stringify({ name: item.name, time: { [item.version]: '2020-01-01T00:00:00.000Z' }, versions: { [item.version]: { name: item.name, version: item.version } } }));
  res.writeHead(200, { 'content-length': body.length }); res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const registry = `http://127.0.0.1:${server.address().port}`;
process.env.NPM_CONFIG_REGISTRY = registry;
const importStart = performance.now();
const { runResidentInstall } = await import('../src/lib/core.js');
const moduleImportMs = performance.now() - importStart;
const report = { schemaVersion: 1, platform: `${process.platform}/${process.arch}`, nodeVersion: process.version, binary, binarySha256: digest(await fs.readFile(binary)), configuration: options, moduleImportMs,
  notes: ['Default policy enabled; local registry metadata, no scripts.', 'Resident first call includes lazy addon/pool initialization; module import recorded separately.', 'Fresh timings include native spawn; Node supervisor startup and fixture setup excluded from both.', 'Ready timings await full canonical report, not queue acceptance or activation alone.', 'At most eight requests outstanding; 20-project cohorts are client-bounded, not a queue-overflow benchmark.', 'Policy evidence cache is shared within this resident process across runs; cold means new artifact/project cache, not all process-global state.', 'Local route counters and proxy environment are not OS-enforced network isolation.', 'No aggregate RSS/CPU measurement; use paired Python harness for fresh child resource accounting.'], runs: [] };
let residentCalls = 0;
async function project(root) {
  await fs.mkdir(root, { recursive: true });
  const dependencies = Object.fromEntries(packages.map(p => [p.name, p.version]));
  const manifest = { name: 'worktree-fixture', version: '1.0.0', dependencies };
  const entries = Object.fromEntries(packages.map(p => [`node_modules/${p.name}`, { name: p.name, version: p.version, resolved: `${registry}/${p.name}-${p.version}.tgz`, integrity: 'sha512-' + digest(p.blob, 'sha512', 'base64') }]));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': manifest, ...entries } }));
}
async function validate(root) {
  for (const p of packages) for (const [name, expected] of Object.entries(p.files)) {
    const actual = await fs.readFile(path.join(root, 'node_modules', p.name, name));
    if (!actual.equals(expected)) throw new Error(`Content mismatch ${root}/${p.name}/${name}`);
  }
  const inventory = (await fs.readdir(path.join(root, 'node_modules'))).filter(n => !n.startsWith('.')).sort();
  if (JSON.stringify(inventory) !== JSON.stringify(packages.map(p => p.name).sort())) throw new Error('Unexpected package inventory');
}
async function install(mode, root, cache) {
  const start = performance.now();
  let parsed, firstResidentCall = false;
  if (mode === 'resident') {
    firstResidentCall = residentCalls++ === 0;
    const residentWatchdog = setTimeout(() => { console.error('Resident timeout; fixture retained:', tmp); process.exit(2); }, timeoutMs);
    try {
      parsed = await runResidentInstall(root, { cacheRoot: cache, scripts: false, nodeLayout: 'hoist', jobs });
    } finally { clearTimeout(residentWatchdog); }
    if (parsed === null) throw new Error('Real resident addon unavailable; no CLI fallback permitted');
  } else {
    parsed = await new Promise((resolve, reject) => {
      const child = spawn(binary, ['install', '--project-root', root, '--cache-root', cache, '--no-scripts', '--hoist', '--jobs', String(jobs)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fresh CLI timed out')); }, timeoutMs);
      child.stdout.on('data', data => { stdout += data; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`CLI exit ${code}: ${stderr}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
  }
  const readyMs = performance.now() - start;
  if (!parsed.ok) throw new Error(`Install failed: ${JSON.stringify(parsed)}`);
  return { readyMs, firstResidentCall, resident: parsed.resident ?? null, timing: parsed.timing ?? null };
}
// A process watchdog bounds uncancellable resident requests. Do not clean up
// active install paths on timeout; the OS temporary directory remains evidence.
const watchdog = setTimeout(() => { console.error('Benchmark timeout; fixture retained:', tmp); process.exit(2); }, timeoutMs * (workers.reduce((a, b) => a + b, 0) * rounds * 6 + 1));
try {
  for (const width of workers) for (let round = 0; round < rounds; round++) {
    for (const mode of (round % 2 ? ['resident', 'fresh-cli'] : ['fresh-cli', 'resident'])) {
      const root = path.join(tmp, `${width}-${round}-${mode}`), cache = path.join(root, 'cache');
      const projects = Array.from({ length: width }, (_, i) => path.join(root, `project-${i}`));
      for (const p of projects) await project(p);
      for (const scenario of ['cold-artifact', 'warm', 'noop']) {
        if (scenario === 'warm') for (const p of projects) await fs.rm(path.join(p, 'node_modules'), { recursive: true, force: true });
        routes = {}; unknown = [];
        const start = performance.now(), results = Array(width);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(width, 8) }, async () => {
          for (;;) { const i = next++; if (i >= width) return; results[i] = await install(mode, projects[i], cache); }
        }));
        const cohortReadyMs = performance.now() - start;
        for (const p of projects) await validate(p);
        if (unknown.length) throw new Error(`Unexpected HTTP routes: ${unknown}`);
        report.runs.push({ mode, width, round: round + 1, scenario, cohortReadyMs, results, http: { ...routes }, validated: true });
        await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      }
    }
  }
  const requestedMetadata = new Set(report.runs.flatMap(run => Object.keys(run.http).filter(route => !route.endsWith('.tgz'))));
  for (const p of packages) if (!requestedMetadata.has(`GET /${p.name}`)) throw new Error(`No local security metadata observed for ${p.name}`);
  const require = createRequire(import.meta.url);
  report.loadedAddons = await Promise.all(Object.keys(require.cache).filter(name => name.endsWith('.node')).map(async name => ({ path: name, sha256: digest(await fs.readFile(name)) })));
  report.ok = true;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, output }));
} finally {
  clearTimeout(watchdog);
  await new Promise(resolve => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}
