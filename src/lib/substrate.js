// Client for the better-core substrate daemon: attach a worktree to a sealed environment.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const DEFAULT_SUBSTRATE_SOCKET = "/run/better/substrate.sock";

/**
 * Asks the substrate daemon to attach projectRoot. Resolves to the daemon's reply, or to
 * { ok: false, reason } when attaching is not possible. Never throws, so install can fall back.
 */
export async function attachSealedEnvironment(projectRoot, {
  socket = process.env.BETTER_SUBSTRATE_SOCKET || DEFAULT_SUBSTRATE_SOCKET,
  platform = process.platform,
  workspaces = false,
  timeoutMs = 120_000
} = {}) {
  if (platform !== "linux") return { ok: false, reason: "Sealed environments need Linux" };
  if (workspaces) return { ok: false, reason: "Sealed environments do not support workspaces" };
  try {
    await fs.access(path.join(projectRoot, "package-lock.json"));
  } catch {
    return { ok: false, reason: "Sealed environments need a package-lock.json" };
  }
  return new Promise(resolve => {
    let reply = "";
    const conn = net.createConnection(socket);
    const finish = value => { conn.destroy(); resolve(value); };
    // Sealing a new environment runs one install, so allow minutes, not seconds.
    conn.setTimeout(timeoutMs, () => finish({ ok: false, reason: "Substrate daemon timed out" }));
    conn.on("connect", () => conn.write(`${JSON.stringify({ op: "attach", project: projectRoot })}\n`));
    conn.on("data", chunk => { reply += chunk; });
    conn.on("end", () => {
      try { finish(JSON.parse(reply)); } catch { finish({ ok: false, reason: "Unreadable substrate daemon reply" }); }
    });
    conn.on("error", error => finish({ ok: false, reason: `Substrate daemon unavailable (${error.code ?? error.message})` }));
  });
}
