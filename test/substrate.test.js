import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { attachSealedEnvironment } from "../src/lib/substrate.js";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/better.js", import.meta.url));

async function fakeDaemon(dir, reply) {
  const socket = path.join(dir, "d.sock");
  const requests = [];
  const server = net.createServer(conn => {
    let line = "";
    conn.on("data", chunk => {
      line += chunk;
      if (line.includes("\n")) { requests.push(JSON.parse(line)); conn.end(`${JSON.stringify(reply)}\n`); }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  return { socket, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test("attach asks the daemon with exactly op and project, and returns its reply", async () => {
  const dir = await makeTempDir("better-substrate-");
  const daemon = await fakeDaemon(dir, { ok: true, id: "a".repeat(64), sealedNow: false, reused: true, ms: 1.5 });
  try {
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
    const reply = await attachSealedEnvironment(dir, { socket: daemon.socket, platform: "linux" });
    assert.deepEqual(daemon.requests, [{ op: "attach", project: dir }]);
    assert.equal(reply.ok, true);
    assert.equal(reply.reused, true);
  } finally {
    await daemon.close();
    await rmrf(dir);
  }
});

test("attach reports why it cannot run instead of throwing", async () => {
  const dir = await makeTempDir("better-substrate-");
  try {
    const reason = async opts => (await attachSealedEnvironment(dir, { socket: path.join(dir, "none.sock"), platform: "linux", ...opts })).reason;
    assert.match(await reason({ platform: "darwin" }), /need Linux/);
    assert.match(await reason({ workspaces: true }), /workspaces/);
    assert.match(await reason({}), /package-lock\.json/);
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
    assert.match(await reason({}), /daemon unavailable/);
  } finally {
    await rmrf(dir);
  }
});

test("install --substrate attaches and skips the install", { skip: process.platform !== "linux" && "sealed environments are Linux-only" }, async () => {
  const dir = await makeTempDir("better-substrate-cli-");
  const daemon = await fakeDaemon(dir, { ok: true, id: "b".repeat(64), target: path.join(dir, "node_modules"), sealedNow: true, reused: false, ms: 2 });
  try {
    await writeJson(path.join(dir, "package.json"), { name: "fixture", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } });
    const cacheRoot = path.join(dir, "cache");
    const { stdout } = await exec(process.execPath, [cli, "install", "--substrate", "--json", "--project-root", dir, "--cache-root", cacheRoot], {
      env: { ...process.env, BETTER_SUBSTRATE_SOCKET: daemon.socket }, timeout: 60_000
    });
    const report = JSON.parse(stdout);
    assert.equal(report.execution.mode, "substrate_attach");
    assert.equal(report.substrate.id, "b".repeat(64));
    assert.equal(daemon.requests.length, 1);
    await assert.rejects(fs.access(cacheRoot), "an attach does no cache work");
  } finally {
    await daemon.close();
    await rmrf(dir);
  }
});
