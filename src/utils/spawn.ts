import { spawn, type SpawnOptions as NodeSpawnOptions } from 'node:child_process';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface SpawnOptions extends NodeSpawnOptions {
  inheritStdio?: boolean;
}

/**
 * Spawn a process and capture its output along with timing metrics.
 *
 * @param cmd - Command to execute
 * @param args - Arguments to pass to the command
 * @param options - Spawn options
 * @returns Promise with exit code, stdout, stderr, and duration
 */
export function spawnWithOutput(
  cmd: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<ExecResult> {
  const start = performance.now();
  const { inheritStdio, ...spawnOpts } = options;

  // Default stdio configuration
  const stdio = inheritStdio ? 'inherit' : ['inherit', 'pipe', 'pipe'];

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      ...spawnOpts,
      stdio: stdio as NodeSpawnOptions['stdio'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    // Only collect output if not inheriting stdio
    if (!inheritStdio) {
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        // Also write to stdout for real-time feedback
        process.stdout.write(data);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        // Also write to stderr for real-time feedback
        process.stderr.write(data);
      });
    }

    proc.on('close', (code) => {
      const duration = Math.round(performance.now() - start);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        duration,
      });
    });

    proc.on('error', (err) => {
      const duration = Math.round(performance.now() - start);
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
        duration,
      });
    });
  });
}
