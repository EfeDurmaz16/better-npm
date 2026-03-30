/**
 * better snapshot — lockfile snapshot management
 *
 * Creates and manages named snapshots of package-lock.json.
 * Useful for rollback, A/B testing, or archiving known-good states.
 *
 * Usage:
 *   better snapshot save <name>       # save current lockfile
 *   better snapshot list              # list all snapshots
 *   better snapshot restore <name>    # restore a snapshot
 *   better snapshot diff <name>       # diff current vs snapshot
 *   better snapshot delete <name>     # delete a snapshot
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SNAPSHOT_DIR_NAME = ".better-snapshots";

async function getSnapshotDir(projectRoot) {
  const dir = path.join(projectRoot, SNAPSHOT_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  // Add to .gitignore if not already there
  try {
    const giPath = path.join(projectRoot, ".gitignore");
    const gi = await fs.readFile(giPath, "utf8").catch(() => "");
    if (!gi.includes(SNAPSHOT_DIR_NAME)) {
      await fs.appendFile(giPath, `\n# better snapshots\n${SNAPSHOT_DIR_NAME}/\n`);
    }
  } catch {}
  return dir;
}

export async function cmdSnapshot(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better snapshot <subcommand> [name]

Manage named snapshots of package-lock.json.

Subcommands:
  save <name>      Save current lockfile as a snapshot
  list             List all snapshots
  restore <name>   Restore a snapshot over the current lockfile
  diff <name>      Show differences between current and a snapshot
  delete <name>    Delete a snapshot

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better snapshot save before-update
  better snapshot list
  better snapshot diff before-update
  better snapshot restore before-update
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const lockPath = path.join(projectRoot, "package-lock.json");
  const sub = positionals[0];
  const snapshotName = positionals[1];

  switch (sub) {
    case "save": {
      if (!snapshotName) {
        printText("Error: snapshot name required. Usage: better snapshot save <name>");
        process.exitCode = 1;
        return;
      }
      let lockContent;
      try {
        lockContent = await fs.readFile(lockPath, "utf8");
      } catch {
        const msg = "No package-lock.json found. Run 'better install' first.";
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }
      const snapDir = await getSnapshotDir(projectRoot);
      const snapPath = path.join(snapDir, `${snapshotName}.lock.json`);
      const meta = {
        name: snapshotName,
        savedAt: new Date().toISOString(),
        lockfileVersion: JSON.parse(lockContent).lockfileVersion,
        packageCount: Object.keys(JSON.parse(lockContent).packages || {}).length,
      };
      await fs.writeFile(snapPath, lockContent);
      await fs.writeFile(snapPath + ".meta.json", JSON.stringify(meta, null, 2));
      if (values.json) {
        printJson({ ok: true, kind: "better.snapshot.save", name: snapshotName, path: snapPath, ...meta });
      } else {
        printText(`\x1b[32m✔\x1b[0m Snapshot '${snapshotName}' saved (${meta.packageCount} packages)`);
      }
      break;
    }

    case "list": {
      const snapDir = await getSnapshotDir(projectRoot);
      const entries = await fs.readdir(snapDir).catch(() => []);
      const snapshots = [];
      for (const f of entries) {
        if (!f.endsWith(".lock.json") || f.endsWith(".meta.json")) continue;
        const name = f.replace(".lock.json", "");
        let meta = { name, savedAt: null, packageCount: null };
        try {
          meta = { ...meta, ...JSON.parse(await fs.readFile(path.join(snapDir, f + ".meta.json"), "utf8")) };
        } catch {}
        snapshots.push(meta);
      }
      if (values.json) {
        printJson({ ok: true, kind: "better.snapshot.list", snapshots });
      } else if (snapshots.length === 0) {
        printText("No snapshots found. Create one with: better snapshot save <name>");
      } else {
        printText(`\n\x1b[1mbetter snapshot list\x1b[0m — ${snapshots.length} snapshot(s)\n`);
        for (const s of snapshots) {
          const date = s.savedAt ? new Date(s.savedAt).toLocaleString() : "unknown";
          printText(`  ${s.name.padEnd(24)} \x1b[90m${date}  ${s.packageCount || "?"} packages\x1b[0m`);
        }
      }
      break;
    }

    case "restore": {
      if (!snapshotName) {
        printText("Error: snapshot name required.");
        process.exitCode = 1;
        return;
      }
      const snapDir = await getSnapshotDir(projectRoot);
      const snapPath = path.join(snapDir, `${snapshotName}.lock.json`);
      let snapContent;
      try {
        snapContent = await fs.readFile(snapPath, "utf8");
      } catch {
        const msg = `Snapshot '${snapshotName}' not found.`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }
      // Backup current before restoring
      const currentContent = await fs.readFile(lockPath, "utf8").catch(() => null);
      if (currentContent) {
        await fs.writeFile(lockPath + ".bak", currentContent);
      }
      await fs.writeFile(lockPath, snapContent);
      if (values.json) {
        printJson({ ok: true, kind: "better.snapshot.restore", name: snapshotName, backed_up: !!currentContent });
      } else {
        printText(`\x1b[32m✔\x1b[0m Restored snapshot '${snapshotName}'`);
        if (currentContent) printText(`\x1b[90mPrevious lockfile backed up to package-lock.json.bak\x1b[0m`);
        printText(`\x1b[90mRun 'better install' to apply the restored lockfile.\x1b[0m`);
      }
      break;
    }

    case "diff": {
      if (!snapshotName) {
        printText("Error: snapshot name required.");
        process.exitCode = 1;
        return;
      }
      const snapDir = await getSnapshotDir(projectRoot);
      const snapPath = path.join(snapDir, `${snapshotName}.lock.json`);
      let snapLock, currentLock;
      try {
        snapLock = JSON.parse(await fs.readFile(snapPath, "utf8"));
        currentLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      } catch (err) {
        const msg = err.message.includes("ENOENT") && err.message.includes("better-snapshots")
          ? `Snapshot '${snapshotName}' not found`
          : `Cannot read lockfile: ${err.message}`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }

      const snapPkgs = {};
      const curPkgs = {};
      for (const [p, info] of Object.entries(snapLock.packages || {})) {
        if (!p || p === "") continue;
        const name = p.startsWith("node_modules/") ? p.slice(13) : p;
        if (name && !name.includes("/node_modules/")) snapPkgs[name] = info.version;
      }
      for (const [p, info] of Object.entries(currentLock.packages || {})) {
        if (!p || p === "") continue;
        const name = p.startsWith("node_modules/") ? p.slice(13) : p;
        if (name && !name.includes("/node_modules/")) curPkgs[name] = info.version;
      }

      const added = Object.keys(curPkgs).filter(n => !snapPkgs[n]);
      const removed = Object.keys(snapPkgs).filter(n => !curPkgs[n]);
      const changed = Object.keys(curPkgs).filter(n => snapPkgs[n] && snapPkgs[n] !== curPkgs[n])
        .map(n => ({ name: n, from: snapPkgs[n], to: curPkgs[n] }));

      if (values.json) {
        printJson({ ok: true, kind: "better.snapshot.diff", snapshot: snapshotName, added, removed, changed });
        return;
      }

      printText(`\n\x1b[1mbetter snapshot diff\x1b[0m — current vs '${snapshotName}'\n`);
      if (added.length === 0 && removed.length === 0 && changed.length === 0) {
        printText("\x1b[32m✔ No differences.\x1b[0m");
        return;
      }
      if (added.length) {
        printText(`\x1b[32m+ Added (${added.length}):\x1b[0m`);
        for (const n of added.slice(0, 10)) printText(`  + ${n}@${curPkgs[n]}`);
        if (added.length > 10) printText(`  \x1b[90m...${added.length - 10} more\x1b[0m`);
      }
      if (removed.length) {
        printText(`\n\x1b[31m- Removed (${removed.length}):\x1b[0m`);
        for (const n of removed.slice(0, 10)) printText(`  - ${n}@${snapPkgs[n]}`);
        if (removed.length > 10) printText(`  \x1b[90m...${removed.length - 10} more\x1b[0m`);
      }
      if (changed.length) {
        printText(`\n\x1b[33m~ Changed (${changed.length}):\x1b[0m`);
        for (const c of changed.slice(0, 10)) {
          printText(`  ~ ${c.name}: ${c.from} → ${c.to}`);
        }
        if (changed.length > 10) printText(`  \x1b[90m...${changed.length - 10} more\x1b[0m`);
      }
      break;
    }

    case "delete": {
      if (!snapshotName) {
        printText("Error: snapshot name required.");
        process.exitCode = 1;
        return;
      }
      const snapDir = await getSnapshotDir(projectRoot);
      const snapPath = path.join(snapDir, `${snapshotName}.lock.json`);
      try {
        await fs.unlink(snapPath);
        await fs.unlink(snapPath + ".meta.json").catch(() => {});
        if (values.json) { printJson({ ok: true, kind: "better.snapshot.delete", name: snapshotName }); }
        else { printText(`\x1b[32m✔\x1b[0m Deleted snapshot '${snapshotName}'`); }
      } catch {
        const msg = `Snapshot '${snapshotName}' not found.`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
      }
      break;
    }

    default: {
      printText(`Unknown subcommand: ${sub}. Run 'better snapshot --help' for usage.`);
      process.exitCode = 1;
    }
  }
}
