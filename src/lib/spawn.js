import { spawn } from "node:child_process";

export async function runCommand(cmd, args, opts = {}) {
  const {
    cwd,
    env,
    passthroughStdio = true,
    captureLimitBytes = 1024 * 1024,
    timeoutMs = null
  } = opts;

  const startedAt = Date.now();
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["inherit", "pipe", "pipe"]
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let timedOut = false;

  let timer = null;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, timeoutMs);
  }

  child.stdout.on("data", (chunk) => {
    if (passthroughStdio) process.stdout.write(chunk);
    if (stdoutBuf.length < captureLimitBytes) stdoutBuf += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    if (passthroughStdio) process.stderr.write(chunk);
    if (stderrBuf.length < captureLimitBytes) stderrBuf += chunk.toString("utf8");
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (timer) clearTimeout(timer);

  const endedAt = Date.now();
  return {
    cmd,
    args,
    cwd,
    startedAt,
    endedAt,
    wallTimeMs: endedAt - startedAt,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    stdoutTail: stdoutBuf.slice(-16_384),
    stderrTail: stderrBuf.slice(-16_384)
  };
}
