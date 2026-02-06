import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Safely execute a command using execFile (no shell injection).
 * Returns result with stdout, stderr, and exitCode instead of throwing.
 */
export async function execFileNoThrow(
  command: string,
  args: string[] = [],
  options: { cwd?: string; encoding?: BufferEncoding } = {}
): Promise<ExecFileResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      ...options,
      encoding: options.encoding ?? 'utf-8',
    });
    return {
      stdout: stdout as string,
      stderr: stderr as string,
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
      exitCode: error.code ?? 1,
    };
  }
}
