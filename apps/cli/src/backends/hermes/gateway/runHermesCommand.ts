import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import type { HermesCommandInvocation, HermesCommandResult } from './attach';

/**
 * Process boundary for one short-lived `hermes` invocation (`gateway attach --json`).
 * Resolves with the exit code instead of rejecting on non-zero exit: the attach verdict
 * is on stdout and the exit code is part of the contract.
 */
export async function runHermesCommand(invocation: HermesCommandInvocation): Promise<HermesCommandResult> {
  const resolved = resolveWindowsCommandInvocation({
    command: invocation.command,
    args: [...invocation.args],
    env: invocation.env,
    resolveCommandOnPath: true,
  });

  return await new Promise<HermesCommandResult>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

    const abort = (): void => { child.kill(); };
    const signal = invocation.signal;
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });

    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (exitCode) => {
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr });
    });
  });
}
