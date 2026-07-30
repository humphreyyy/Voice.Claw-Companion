import { execFile } from 'node:child_process';

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult>;
}

function bounded(value: string): string {
  return Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
}

export class ExecFileCommandRunner implements CommandRunner {
  public run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(executable, [...args], {
        encoding: 'utf8',
        env: options.env,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout: bounded(stdout),
            stderr: bounded(stderr),
            exitCode: 0,
          });
          return;
        }

        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          reject(error);
          return;
        }

        resolve({
          stdout: bounded(stdout),
          stderr: bounded(stderr || error.message),
          exitCode: typeof code === 'number' ? code : error.killed ? 124 : 1,
        });
      });
    });
  }
}
