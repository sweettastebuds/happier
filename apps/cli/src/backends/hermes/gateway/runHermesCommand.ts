import { runCommandCapture } from '@happier-dev/cli-common/process';

import type { HermesCommandInvocation, HermesCommandResult } from './attach';

/**
 * Time budget for one short-lived `hermes` invocation. `gateway attach` waits at most 5s for gateway
 * discovery (hermes_cli/gateway_runtime_attach.py DISCOVER_TIMEOUT) and `profile list` starts a Python
 * process; the UI waits 10s for the profile list, so the child must fail inside that window to be
 * able to report why.
 */
export const HERMES_COMMAND_TIMEOUT_MS = 8_000;

export class HermesCommandTimeoutError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(timeoutMs: number, stdout: string, stderr: string) {
    super(`the Hermes CLI timed out after ${timeoutMs}ms`);
    this.name = 'HermesCommandTimeoutError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Process boundary for one short-lived `hermes` invocation (`gateway attach --json`, `profile list`).
 * Resolves with the exit code instead of rejecting on non-zero exit: the attach verdict is on stdout
 * and the exit code is part of the contract. Spawn failure, abort and timeout reject; the child is
 * terminated by the shared process owner in the last two cases.
 */
export async function runHermesCommand(invocation: HermesCommandInvocation): Promise<HermesCommandResult> {
  const result = await runCommandCapture({
    cmd: invocation.command,
    args: invocation.args,
    env: invocation.env,
    signal: invocation.signal,
    timeoutMs: invocation.timeoutMs ?? HERMES_COMMAND_TIMEOUT_MS,
    resolveCommandOnPath: true,
  });
  switch (result.kind) {
    case 'exited': return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    case 'timed-out': throw new HermesCommandTimeoutError(result.timeoutMs, result.stdout, result.stderr);
    case 'aborted': throw result.error;
    case 'spawn-failed': throw result.error;
  }
}
