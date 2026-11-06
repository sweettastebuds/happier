import { describe, expect, it } from 'vitest';

import {
  attachHermesGateway,
  buildHermesAttachArgs,
  isHermesGatewayUnavailableError,
  type HermesCommandInvocation,
  type HermesCommandResult,
  type HermesCommandRunner,
} from './attach';
import { runHermesCommand } from './runHermesCommand';

// Fixture provenance: the verdict shape is `hermes_cli/gateway_runtime_cli.py::cmd_gateway_attach`
// (Hermes 6b21d0564de0). No live capture exists (third-party binary execution was denied in the
// capture lane), so every payload below is derived from that source.
function attachPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'ready',
    reason_code: null,
    endpoint: {
      profile_id: '/home/u/.hermes/profiles/work',
      instance_id: 'inst-1',
      authority_epoch: 3,
      runtime_protocol: 1,
      api_origin: 'http://127.0.0.1:9119',
      supervisor: 'manual',
      capabilities: ['durable-admission-v1', 'event-replay-v1'],
      control_home: '/home/u/.hermes',
      code_sha: 'abc123',
    },
    client_code_sha: 'abc123',
    url: 'ws://127.0.0.1:9119/api/ws',
    protocol: 'hermes-gateway-v1',
    protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t-1'],
    ticket: 't-1',
    ...overrides,
  });
}

function fakeRunner(result: HermesCommandResult | Error) {
  const calls: HermesCommandInvocation[] = [];
  const run: HermesCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, run };
}

const launch = { command: 'hermes', args: [] as string[] };

describe('buildHermesAttachArgs', () => {
  it('only discovers an already-running gateway: never start, recover or run one', () => {
    for (const profile of [undefined, null, 'work']) {
      const args = buildHermesAttachArgs(profile);
      expect(args).not.toContain('--start');
      expect(args).not.toContain('--recover');
      expect(args).not.toContain('run');
      expect(args.slice(-3)).toEqual(['gateway', 'attach', '--json']);
    }
  });

  it('selects a profile with -p before the subcommand and omits it for the active profile', () => {
    expect(buildHermesAttachArgs('work')).toEqual(['-p', 'work', 'gateway', 'attach', '--json']);
    expect(buildHermesAttachArgs(null)).toEqual(['gateway', 'attach', '--json']);
  });

  it('rejects profile names that could be read as flags or paths', () => {
    for (const bad of ['--start', '-x', 'a b', '../x', '']) {
      expect(() => buildHermesAttachArgs(bad)).toThrow(/Hermes profile name/);
    }
  });
});

describe('attachHermesGateway', () => {
  it('parses the attach verdict into a connection target and endpoint identity', async () => {
    const { run, calls } = fakeRunner({ exitCode: 0, stdout: `${attachPayload()}\n`, stderr: '' });
    const attachment = await attachHermesGateway({ launch, profile: 'work', env: { PATH: '/bin' }, run });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('hermes');
    expect(calls[0]!.args).toEqual(['-p', 'work', 'gateway', 'attach', '--json']);
    expect(attachment).toMatchObject({
      url: 'ws://127.0.0.1:9119/api/ws',
      ticket: 't-1',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t-1'],
      profileId: '/home/u/.hermes/profiles/work',
      instanceId: 'inst-1',
      runtimeProtocol: 1,
      capabilities: ['durable-admission-v1', 'event-replay-v1'],
      codeSha: 'abc123',
      clientCodeSha: 'abc123',
      codeDrift: false,
    });
  });

  it('flags code drift when the gateway outlived a Hermes update', async () => {
    const { run } = fakeRunner({ exitCode: 0, stdout: attachPayload({ client_code_sha: 'new999' }), stderr: '' });
    const attachment = await attachHermesGateway({ launch, env: {}, run });
    expect(attachment.codeDrift).toBe(true);
  });

  it('does not report drift when either side has no code identity', async () => {
    const { run } = fakeRunner({ exitCode: 0, stdout: attachPayload({ client_code_sha: null }), stderr: '' });
    expect((await attachHermesGateway({ launch, env: {}, run })).codeDrift).toBe(false);
  });

  it.each([
    [2, 'invalid_invocation', /rejected/i],
    [3, 'incompatible', /update Hermes/i],
    [4, 'profile_mismatch', /profile/i],
    [5, 'gateway_not_running', /start your Hermes gateway/i],
    [6, 'draining', /restarting|updating/i],
    [7, 'inaccessible', /not accessible/i],
  ] as const)('maps exit code %i to a user-facing %s error', async (exitCode, kind, message) => {
    const failure = JSON.stringify({ state: 'absent', reason_code: 'x', endpoint: null, message: 'gateway absent: x' });
    const { run } = fakeRunner({ exitCode, stdout: failure, stderr: 'gateway absent: x' });
    const error = await attachHermesGateway({ launch, profile: 'work', env: {}, run }).catch((e: unknown) => e);
    expect(isHermesGatewayUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({ kind, exitCode });
    expect((error as Error).message).toMatch(message);
  });

  it('names the profile and tells the user to start the gateway themselves when none is running', async () => {
    const { run } = fakeRunner({ exitCode: 5, stdout: '', stderr: '' });
    const error = (await attachHermesGateway({ launch, profile: 'work', env: {}, run }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('work');
    expect(error.message).toMatch(/Happier never starts/i);
  });

  it('rejects unparseable or ticketless success output instead of guessing', async () => {
    for (const stdout of ['not json', '[]', attachPayload({ ticket: undefined }), attachPayload({ url: undefined })]) {
      const { run } = fakeRunner({ exitCode: 0, stdout, stderr: '' });
      const error = await attachHermesGateway({ launch, env: {}, run }).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: 'malformed_output' });
    }
  });

  it('reports a missing hermes executable as a launch failure', async () => {
    const enoent = Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT' });
    const { run } = fakeRunner(enoent);
    const error = await attachHermesGateway({ launch, env: {}, run }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'launch_failed' });
    expect((error as Error).message).toMatch(/Hermes CLI/);
  });

  it('never leaks the single-use ticket into error messages', async () => {
    const { run } = fakeRunner({ exitCode: 0, stdout: attachPayload({ url: undefined }), stderr: '' });
    const error = (await attachHermesGateway({ launch, env: {}, run }).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('t-1');
  });
});

describe('runHermesCommand (process boundary)', () => {
  it('captures stdout, stderr and the exit code of a real child process', async () => {
    const result = await runHermesCommand({
      command: process.execPath,
      args: ['-e', "process.stdout.write('out');process.stderr.write('err');process.exit(5)"],
      env: process.env,
    });
    expect(result).toEqual({ exitCode: 5, stdout: 'out', stderr: 'err' });
  });

  it('rejects with the spawn error when the executable does not exist', async () => {
    await expect(runHermesCommand({
      command: 'definitely-not-a-real-hermes-binary',
      args: [],
      env: process.env,
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
