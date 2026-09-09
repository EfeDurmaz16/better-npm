import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tryLoadNapiAddon } from "../../src/lib/core.js";

const addon = tryLoadNapiAddon();
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "better-resident-io-"));
let holder;
let requests = [];
try {
  const cache = path.join(directory, "cache");
  await fs.mkdir(path.join(cache, "store"), { recursive: true });
  const projects = [];
  for (let i = 0; i < 4; i++) {
    const project = path.join(directory, `project-${i}`);
    await fs.mkdir(project);
    const manifest = { name: `fixture-${i}`, version: "1.0.0" };
    await fs.writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": manifest } }));
    await fs.writeFile(path.join(project, ".better-firewall.json"), '{"enabled":false}');
    projects.push(project);
  }
  const probe = path.join(directory, "probe.txt");
  await fs.writeFile(probe, "fs remains responsive");
  // An exclusive artifact lifecycle lease stops all four installs after resolve.
  holder = spawn(process.argv[2], ["state-lock", "--lock-path", path.join(cache, "store", "artifact-lifecycle.lock")], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lock helper timed out")), 5000);
    holder.once("error", (error) => { clearTimeout(timer); reject(error); });
    holder.stdout.once("data", (data) => {
      clearTimeout(timer);
      if (data.toString().trim() === "ready") resolve();
      else reject(new Error("Unexpected lock helper reply"));
    });
    holder.once("exit", () => { clearTimeout(timer); reject(new Error("Lock helper exited before ready")); });
  });
  let completed = 0;
  requests = projects.map((projectRoot) => addon.installResident(JSON.stringify({ projectRoot, cacheRoot: cache, offline: true, scripts: false })).then((json) => { completed++; return JSON.parse(json); }));
  // Timers do not use the libuv worker pool. Give old AsyncTask waiters time to
  // occupy its four configured workers while the native jobs remain blocked.
  await new Promise((resolve) => setTimeout(resolve, 150));
  let timer;
  let observed;
  let completedBeforeRelease;
  try {
    observed = await Promise.race([
      fs.readFile(probe, "utf8"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("TIMED_OUT"), 2000); })
    ]);
  } finally {
    clearTimeout(timer);
    completedBeforeRelease = completed;
    // Release before assertions and before awaiting installs, including timeout.
    const exited = once(holder, "exit");
    holder.stdin.end();
    await exited;
  }
  const reports = await Promise.all(requests);
  assert.equal(observed, "fs remains responsive");
  assert.equal(completedBeforeRelease, 0, "Installs must remain blocked during the fs probe");
  assert.equal(completed, 4);
  assert.ok(reports.every((report) => report.ok && report.resident));
  console.log(JSON.stringify({ responsive: true, completed }));
} finally {
  if (holder && holder.exitCode === null) {
    holder.stdin.end();
    holder.kill();
  }
  await Promise.allSettled(requests);
  await fs.rm(directory, { recursive: true, force: true });
}
