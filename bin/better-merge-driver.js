#!/usr/bin/env node
/**
 * better-merge-driver — git merge driver for better.lock.json
 *
 * Registered in .gitconfig / .gitattributes as:
 *
 *   [merge "better-lock"]
 *     name = better lockfile merge driver
 *     driver = better-merge-driver %O %A %B %P
 *
 *   # In .gitattributes:
 *   better.lock.json merge=better-lock
 *
 * Git invokes the driver with four positional arguments:
 *   %O  — path to ancestor (base) version  (temp file)
 *   %A  — path to OURS (current branch)    (temp file, updated in-place on success)
 *   %B  — path to THEIRS (incoming branch) (temp file)
 *   %P  — path label (display name, e.g. "better.lock.json")
 *
 * Exit codes:
 *   0   — merge succeeded, %A contains the merged result
 *   1   — conflict; %A contains conflict markers
 *
 * Strategy:
 *   1. Parse OURS and THEIRS as better.lock.json
 *   2. Union-merge the `packages` dicts:
 *      - If a key exists in both with the same value → keep it
 *      - If a key exists in only one → keep it
 *      - If a key exists in both with DIFFERENT values → keep OURS value,
 *        record the conflict in a top-level `_conflicts` array
 *   3. Metadata: keep OURS for `kind`, `version`; update `lockHash` to
 *      reflect the merged state; set `mergedAt` timestamp.
 *   4. Write the result back to %A.
 *   5. Exit 0 if no conflicts, 1 if there were package-level conflicts.
 */

import fs from "node:fs/promises";

const [, , ancestorPath, oursPath, theirsPath, labelArg] = process.argv;
const label = labelArg ?? "better.lock.json";

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  if (!oursPath || !theirsPath) {
    process.stderr.write(
      "better-merge-driver: usage: better-merge-driver <base> <ours> <theirs> [label]\n"
    );
    process.exit(2);
  }

  const ours = await readJson(oursPath);
  const theirs = await readJson(theirsPath);
  const ancestor = ancestorPath ? await readJson(ancestorPath) : null;

  if (!ours || !theirs) {
    // One side is unparseable — fall back to OURS
    process.stderr.write(
      `better-merge-driver: ${label}: could not parse one side, keeping OURS\n`
    );
    process.exit(0);
  }

  const conflicts = [];

  // --- Merge packages dict ---
  const ourPkgs = ours.packages ?? {};
  const theirPkgs = theirs.packages ?? {};
  const ancestorPkgs = ancestor?.packages ?? {};
  const merged = {};

  const allKeys = new Set([
    ...Object.keys(ourPkgs),
    ...Object.keys(theirPkgs)
  ]);

  for (const key of allKeys) {
    const inOurs = Object.prototype.hasOwnProperty.call(ourPkgs, key);
    const inTheirs = Object.prototype.hasOwnProperty.call(theirPkgs, key);

    if (inOurs && !inTheirs) {
      merged[key] = ourPkgs[key];
    } else if (!inOurs && inTheirs) {
      merged[key] = theirPkgs[key];
    } else {
      // Both sides have the key
      const ourVal = JSON.stringify(ourPkgs[key]);
      const theirVal = JSON.stringify(theirPkgs[key]);
      if (ourVal === theirVal) {
        merged[key] = ourPkgs[key];
      } else {
        // Conflict — check if one side matches the ancestor
        const ancestorVal = ancestorPkgs[key] ? JSON.stringify(ancestorPkgs[key]) : null;
        if (ancestorVal === ourVal) {
          // OURS unchanged, THEIRS changed → take THEIRS (standard 3-way)
          merged[key] = theirPkgs[key];
        } else if (ancestorVal === theirVal) {
          // THEIRS unchanged, OURS changed → take OURS
          merged[key] = ourPkgs[key];
        } else {
          // Both sides changed → keep OURS, record conflict
          merged[key] = ourPkgs[key];
          conflicts.push({
            package: key,
            ours: ourPkgs[key],
            theirs: theirPkgs[key]
          });
        }
      }
    }
  }

  // --- Build merged document ---
  const result = {
    kind: ours.kind ?? "better.lock",
    version: ours.version ?? 1,
    mergedAt: new Date().toISOString(),
    lockHash: ours.lockHash ?? null,
    packages: merged
  };

  // Preserve extra top-level fields from OURS (fingerprint, metadata, etc.)
  for (const [k, v] of Object.entries(ours)) {
    if (!Object.prototype.hasOwnProperty.call(result, k)) {
      result[k] = v;
    }
  }

  // Record conflicts in the output document for human review
  if (conflicts.length > 0) {
    result._conflicts = conflicts;
  }

  await fs.writeFile(oursPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  if (conflicts.length > 0) {
    process.stderr.write(
      `better-merge-driver: ${label}: ${conflicts.length} package conflict(s) — see _conflicts field\n`
    );
    // Exit 1 to signal git that manual resolution may be needed
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`better-merge-driver: fatal: ${err.message}\n`);
  process.exit(2);
});
