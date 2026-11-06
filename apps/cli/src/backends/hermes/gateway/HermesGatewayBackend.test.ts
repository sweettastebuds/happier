import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent/core';
import type { PermissionResult } from '@/agent/permissions/permissionResult';

import { HermesGatewayBackend, type HermesGatewayBackendOptions } from './HermesGatewayBackend';
import {
  createFakeAttachRunner,
  FakeGatewayRpcFailure,
  startFakeHermesGateway,
  type FakeHermesGateway,
} from './fakeHermesGateway.testkit';

// Frame provenance: Hermes tui_gateway/contracts/{canonical,canonical_sessions,events}.py at
// 6b21d0564de0. The capture lane could not execute Hermes, so these are source-derived, not recorded.

const SESSION = 'sess-1';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    stored_session_id: SESSION,
    messages: [],
    message_count: 0,
    running: false,
    authority_epoch: 1,
    replay_epoch: 'epoch-1',
    last_sequence: 0,
    subscription_id: 'sub-1',
    revision: 7,
    execution_generation: 3,
    pending: [],
    prompts: [],
    info: { desktop_protocol: 'hermes-gateway-v1', model: 'claude-x', provider: 'anthropic', profile_id: '/home/u/.hermes/profiles/work', profile_name: 'work' },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    admission_id: 'adm-1',
    ref: { profile_id: '/home/u/.hermes/profiles/work', session_id: SESSION },
    sequence: 1,
    status: 'started',
    outcome: null,
    authority_epoch: 1,
    execution_generation: 3,
    ...overrides,
  };
}

function makePermissionHandler(decide: (toolName: string, input: unknown) => PermissionResult | Promise<PermissionResult>) {
  const calls: Array<{ id: string; toolName: string; input: unknown }> = [];
  const cancelPendingRequest = vi.fn(() => true);
  const abortPendingRequestsAndFlush = vi.fn(async () => undefined);
  const handler: AcpPermissionHandler = {
    handleToolCall: async (id: string, toolName: string, input: unknown) => {
      calls.push({ id, toolName, input });
      return await decide(toolName, input);
    },
    cancelPendingRequest,
    abortPendingRequestsAndFlush,
  } as unknown as AcpPermissionHandler;
  return { handler, calls, cancelPendingRequest, abortPendingRequestsAndFlush };
}

describe('HermesGatewayBackend', () => {
  const gateways: FakeHermesGateway[] = [];
  const backends: HermesGatewayBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.dispose()));
    await Promise.all(gateways.splice(0).map((g) => g.close()));
  });

  async function setup(extra: {
    methods?: Parameters<typeof startFakeHermesGateway>[0] extends infer O ? (O extends { methods?: infer M } ? M : never) : never;
    runtime?: Record<string, unknown>;
    attachOptions?: Parameters<typeof createFakeAttachRunner>[1];
    backend?: Partial<HermesGatewayBackendOptions>;
  } = {}) {
    const gateway = await startFakeHermesGateway({
      runtime: extra.runtime,
      methods: {
        'session.create': () => snapshot(),
        'session.resume': () => snapshot(),
        'prompt.submit': () => receipt(),
        'session.interrupt': () => ({ execution_generation: 3, execution_state: 'idle' }),
        'session.steer': () => ({ status: 'queued', text: 'x', execution_generation: 3, authority_epoch: 1 }),
        'session.mutate': () => ({ session_id: SESSION, operation: 'model', revision: 8 }),
        'approval.respond': () => ({ status: 'resolved', prompt_id: 'p' }),
        'clarify.respond': () => ({ status: 'resolved', prompt_id: 'p' }),
        'model.options': () => ({
          providers: [
            { slug: 'anthropic', name: 'Anthropic', models: ['claude-x', 'claude-y'], authenticated: true },
            { slug: 'nokey', name: 'No key', models: ['m'], authenticated: false },
          ],
          model: 'claude-x',
          provider: 'anthropic',
        }),
        ...(extra.methods ?? {}),
      },
    });
    gateways.push(gateway);
    const attach = createFakeAttachRunner(gateway, { profileId: '/home/u/.hermes/profiles/work', ...extra.attachOptions });
    const messages: AgentMessage[] = [];
    const backend = new HermesGatewayBackend({
      cwd: '/work/project',
      env: {},
      resolveLaunch: () => ({ command: 'hermes', args: [] }),
      runCommand: attach.run,
      ...extra.backend,
    });
    backend.onMessage((m) => messages.push(m));
    backends.push(backend);
    return { gateway, backend, messages, attach };
  }

  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  describe('connecting', () => {
    it('attaches to the running gateway of the requested profile and never starts one', async () => {
      const { backend, attach } = await setup({ backend: { profile: { name: 'work', expectedProfileId: null } } });
      await backend.startSession();
      expect(attach.calls).toHaveLength(1);
      expect(attach.calls[0]!.args).toEqual(['-p', 'work', 'gateway', 'attach', '--json']);
    });

    it('uses the active Hermes profile when none is requested', async () => {
      const { backend, attach } = await setup();
      await backend.startSession();
      expect(attach.calls[0]!.args).toEqual(['gateway', 'attach', '--json']);
    });

    it('turns a non-zero attach exit into the user-facing "start your gateway" error', async () => {
      const { backend } = await setup({ attachOptions: { failWith: { exitCode: 5 } } });
      await expect(backend.startSession()).rejects.toMatchObject({ kind: 'gateway_not_running' });
    });

    it('surfaces a restart-required notice when the gateway outlived a Hermes update', async () => {
      const { backend, messages } = await setup({ attachOptions: { codeSha: 'old', clientCodeSha: 'new' } });
      await backend.startSession();
      const notice = messages.find((m) => m.type === 'event' && m.name === 'message');
      expect(notice).toBeTruthy();
      expect(JSON.stringify(notice)).toMatch(/restart your Hermes gateway/i);
      await backend.startSession().catch(() => undefined);
      expect(messages.filter((m) => m.type === 'event' && m.name === 'message' && /restart your Hermes gateway/i.test(JSON.stringify(m)))).toHaveLength(1);
    });
  });

  describe('session lifecycle', () => {
    it('creates a session with a deliberately chosen source and records the resolved profile', async () => {
      const onProfileBound = vi.fn();
      const { backend, gateway, messages } = await setup({ backend: { onProfileBound } });
      const result = await backend.startSession();

      expect(result.sessionId).toBe(SESSION);
      const create = gateway.requests.find((r) => r.method === 'session.create')!;
      expect(create.params).toMatchObject({ source: 'tui', cwd: '/work/project' });
      expect(typeof create.params.request_id).toBe('string');
      expect(onProfileBound).toHaveBeenCalledWith({ profileId: '/home/u/.hermes/profiles/work', name: 'work' });
      expect(messages).toContainEqual({ type: 'event', name: 'current_model_update', payload: { currentModelId: 'anthropic:claude-x' } });
    });

    it('prefers the requested profile name over the one Hermes reports and ignores the generic custom profile', async () => {
      const onProfileBound = vi.fn();
      const { backend } = await setup({
        backend: { onProfileBound, profile: { name: 'work', expectedProfileId: null } },
        methods: { 'session.create': () => snapshot({ info: { model: 'm', provider: 'p', profile_name: 'custom' } }) },
      });
      await backend.startSession();
      expect(onProfileBound).toHaveBeenCalledWith({ profileId: '/home/u/.hermes/profiles/work', name: 'work' });

      const second = await setup({
        backend: { onProfileBound },
        methods: { 'session.create': () => snapshot({ info: { model: 'm', provider: 'p', profile_name: 'custom' } }) },
      });
      onProfileBound.mockClear();
      await second.backend.startSession();
      expect(onProfileBound).toHaveBeenCalledWith({ profileId: '/home/u/.hermes/profiles/work', name: null });
    });

    it('falls back to the cli source and refuses a gateway that offers neither tui nor cli', async () => {
      const cli = await setup({ runtime: { instance_id: 'i', profile_id: '/p', authority_epoch: 1, capabilities: ['durable-admission-v1', 'event-replay-v1'], session_create: { sources: ['cli'], parameters: [] } } });
      await cli.backend.startSession();
      expect(cli.gateway.requests.find((r) => r.method === 'session.create')!.params.source).toBe('cli');

      const none = await setup({ runtime: { instance_id: 'i', profile_id: '/p', authority_epoch: 1, capabilities: ['durable-admission-v1', 'event-replay-v1'], session_create: { sources: ['acp'], parameters: [] } } });
      await expect(none.backend.startSession()).rejects.toThrow(/update Hermes/i);
    });

    it('resumes by session id without importing history, and only on the profile the session was created with', async () => {
      const { backend, gateway } = await setup({ backend: { profile: { name: 'work', expectedProfileId: '/home/u/.hermes/profiles/work' } } });
      const result = await backend.loadSession(SESSION);
      expect(result.sessionId).toBe(SESSION);
      expect(gateway.requests.find((r) => r.method === 'session.resume')!.params).toEqual({ session_id: SESSION, omit_messages: true });
      expect(gateway.requests.some((r) => r.method === 'session.create')).toBe(false);
    });

    it('refuses to resume on a different profile than the one recorded', async () => {
      const { backend, gateway } = await setup({ backend: { profile: { name: null, expectedProfileId: '/home/u/.hermes/profiles/other' } } });
      await expect(backend.loadSession(SESSION)).rejects.toMatchObject({ kind: 'profile_mismatch' });
      expect(gateway.requests.some((r) => r.method === 'session.resume')).toBe(false);
    });

    it('propagates a resume the gateway rejects so the caller can fall back to a fresh session', async () => {
      const { backend } = await setup({ methods: { 'session.resume': () => { throw new FakeGatewayRpcFailure(4004, 'not_found'); } } });
      await expect(backend.loadSession('gone')).rejects.toMatchObject({ code: 4004 });
    });
  });

  describe('turns', () => {
    it('submits a prompt and maps the streamed turn through to completion', async () => {
      const { backend, gateway, messages } = await setup();
      await backend.startSession();
      await backend.sendPrompt(SESSION, 'hello');

      const submit = gateway.requests.find((r) => r.method === 'prompt.submit')!;
      expect(submit.params).toMatchObject({ session_id: SESSION, text: 'hello' });
      expect(typeof submit.params.submission_id).toBe('string');

      const completion = backend.waitForResponseComplete!();
      gateway.emit('message.start', SESSION, {}, { execution_generation: 3 });
      gateway.emit('message.delta', SESSION, { text: 'Hi', turn_id: 't', segment: 0, offset: 0 });
      gateway.emit('tool.start', SESSION, { tool_id: 'c1', name: 'terminal', args: { command: 'ls' } });
      gateway.emit('tool.complete', SESSION, { tool_id: 'c1', name: 'terminal', result: { output: 'x' } });
      gateway.emit('message.complete', SESSION, { text: 'Hi', status: 'complete', response_reused: true });
      await expect(completion).resolves.toEqual({ kind: 'completed', stopReason: 'end_turn' });

      expect(messages.filter((m) => m.type !== 'event')).toEqual([
        { type: 'status', status: 'running' },
        { type: 'model-output', textDelta: 'Hi' },
        { type: 'tool-call', callId: 'c1', toolName: 'terminal', args: { command: 'ls' } },
        { type: 'tool-result', callId: 'c1', toolName: 'terminal', result: { output: 'x' } },
        { type: 'status', status: 'idle', turnFinished: true },
      ]);
    });

    it('reports a failed turn through the turn outcome', async () => {
      const { backend, gateway } = await setup();
      await backend.startSession();
      await backend.sendPrompt(SESSION, 'hello');
      const completion = backend.waitForResponseComplete!();
      gateway.emit('message.complete', SESSION, { text: '', status: 'error', error: 'provider 500' });
      const outcome = await completion;
      expect(outcome).toMatchObject({ kind: 'failed' });
    });

    it('ignores events of other sessions on the shared connection', async () => {
      const { backend, gateway, messages } = await setup();
      await backend.startSession();
      gateway.emit('message.delta', 'someone-else', { text: 'leak' });
      await settle();
      expect(messages.some((m) => m.type === 'model-output')).toBe(false);
    });

    it('steers a running turn with the current execution generation', async () => {
      const { backend, gateway } = await setup();
      await backend.startSession();
      await backend.sendPrompt(SESSION, 'go');
      gateway.emit('message.start', SESSION, {}, { execution_generation: 4 });
      await settle();
      await backend.sendSteerPrompt!(SESSION, 'also do x');
      expect(gateway.requests.find((r) => r.method === 'session.steer')!.params).toEqual({ session_id: SESSION, execution_generation: 4, text: 'also do x' });
    });

    it('interrupts with the generation fence, aborts pending approvals and settles the turn as cancelled', async () => {
      const permission = makePermissionHandler(() => ({ decision: 'approved' }));
      const { backend, gateway } = await setup({ backend: { permissionHandler: permission.handler } });
      await backend.startSession();
      await backend.sendPrompt(SESSION, 'go');
      const completion = backend.waitForResponseComplete!();
      await backend.cancel(SESSION);

      expect(gateway.requests.find((r) => r.method === 'session.interrupt')!.params).toEqual({ session_id: SESSION, execution_generation: 3 });
      expect(permission.abortPendingRequestsAndFlush).toHaveBeenCalled();
      gateway.emit('message.complete', SESSION, { text: '', status: 'interrupted' });
      await expect(completion).resolves.toEqual({ kind: 'aborted', stopReason: 'cancelled' });
    });
  });

  describe('approvals and questions', () => {
    const approval = {
      prompt_id: 'ap-1', execution_generation: 3, kind: 'approval', command: 'rm -rf build', description: 'delete build dir',
      choices: ['once', 'deny', 'session', 'always'],
    };

    it.each([
      ['approved', 'once'],
      ['approved_for_session', 'session'],
      ['approved_execpolicy_amendment', 'session'],
      ['denied', 'deny'],
      ['abort', 'deny'],
    ] as const)('routes approval.request through the permission flow: %s -> %s', async (decision, choice) => {
      const permission = makePermissionHandler(() => ({ decision }));
      const { backend, gateway } = await setup({ backend: { permissionHandler: permission.handler } });
      await backend.startSession();
      gateway.emit('approval.request', SESSION, approval, { execution_generation: 3 });
      await settle(80);

      expect(permission.calls).toEqual([{ id: 'ap-1', toolName: 'Bash', input: { command: 'rm -rf build', description: 'delete build dir' } }]);
      expect(gateway.requests.find((r) => r.method === 'approval.respond')!.params).toEqual({
        session_id: SESSION, execution_generation: 3, prompt_id: 'ap-1', choice,
      });
    });

    it('denies when no permission handler is attached and never grants a choice the prompt did not offer', async () => {
      const { backend, gateway } = await setup();
      await backend.startSession();
      gateway.emit('approval.request', SESSION, { ...approval, prompt_id: 'ap-2' }, { execution_generation: 3 });
      await settle(80);
      expect(gateway.requests.find((r) => r.method === 'approval.respond')!.params).toMatchObject({ prompt_id: 'ap-2', choice: 'deny' });

      const permission = makePermissionHandler(() => ({ decision: 'approved_for_session' }));
      const limited = await setup({ backend: { permissionHandler: permission.handler } });
      await limited.backend.startSession();
      limited.gateway.emit('approval.request', SESSION, { ...approval, prompt_id: 'ap-3', choices: ['once', 'deny'] }, { execution_generation: 3 });
      await settle(80);
      expect(limited.gateway.requests.find((r) => r.method === 'approval.respond')!.params).toMatchObject({ prompt_id: 'ap-3', choice: 'once' });
    });

    it('withdraws a pending approval another viewer already settled', async () => {
      const gate = new Promise<PermissionResult>(() => {});
      const permission = makePermissionHandler(() => gate);
      const { backend, gateway } = await setup({ backend: { permissionHandler: permission.handler } });
      await backend.startSession();
      gateway.emit('approval.request', SESSION, approval, { execution_generation: 3 });
      await settle();
      gateway.emit('approval.settled', SESSION, { prompt_id: 'ap-1', execution_generation: 3 });
      await settle();
      expect(permission.cancelPendingRequest).toHaveBeenCalledWith('ap-1', expect.any(String));
      expect(gateway.requests.some((r) => r.method === 'approval.respond')).toBe(false);
    });

    it('answers approvals that were already open when the session is resumed, once', async () => {
      const permission = makePermissionHandler(() => ({ decision: 'approved' }));
      const { backend, gateway } = await setup({
        backend: { permissionHandler: permission.handler },
        methods: { 'session.resume': () => snapshot({ running: true, prompts: [approval] }) },
      });
      await backend.loadSession(SESSION);
      await settle(80);
      gateway.emit('approval.request', SESSION, approval, { execution_generation: 3 });
      await settle(80);
      expect(permission.calls).toHaveLength(1);
      expect(gateway.requests.filter((r) => r.method === 'approval.respond')).toHaveLength(1);
    });

    it('turns clarify.request into a question and answers it with clarify.respond', async () => {
      const permission = makePermissionHandler(() => ({ decision: 'approved', answers: { 'cl-1': ['Option B'] } }));
      const { backend, gateway } = await setup({ backend: { permissionHandler: permission.handler } });
      await backend.startSession();
      gateway.emit('clarify.request', SESSION, {
        kind: 'clarify', prompt_id: 'cl-1', execution_generation: 3, question: 'Which one?', choices: ['Option A', 'Option B'], multi_select: false,
      }, { execution_generation: 3 });
      await settle(80);

      expect(permission.calls[0]).toMatchObject({ id: 'cl-1', toolName: 'AskUserQuestion' });
      expect(permission.calls[0]!.input).toMatchObject({
        questions: [{ id: 'cl-1', question: 'Which one?', multiSelect: false, options: [{ label: 'Option A' }, { label: 'Option B' }] }],
      });
      expect(gateway.requests.find((r) => r.method === 'clarify.respond')!.params).toEqual({
        session_id: SESSION, execution_generation: 3, prompt_id: 'cl-1', answer: 'Option B',
      });
    });

    it('answers a declined question with an empty (skipped) answer', async () => {
      const permission = makePermissionHandler(() => ({ decision: 'denied' }));
      const { backend, gateway } = await setup({ backend: { permissionHandler: permission.handler } });
      await backend.startSession();
      gateway.emit('clarify.request', SESSION, { kind: 'clarify', prompt_id: 'cl-2', execution_generation: 3, question: 'Q?', choices: [], multi_select: false }, { execution_generation: 3 });
      await settle(80);
      expect(gateway.requests.find((r) => r.method === 'clarify.respond')!.params).toMatchObject({ prompt_id: 'cl-2', answer: '' });
    });
  });

  describe('model', () => {
    it('publishes the provider-qualified model list for the session', async () => {
      const { backend, messages } = await setup();
      await backend.startSession();
      await settle(80);
      const state = messages.find((m) => m.type === 'event' && m.name === 'session_models_state');
      expect(state).toMatchObject({
        payload: {
          currentModelId: 'anthropic:claude-x',
          availableModels: [
            { id: 'anthropic:claude-x', name: 'claude-x' },
            { id: 'anthropic:claude-y', name: 'claude-y' },
          ],
        },
      });
    });

    it('changes the model with a revision- and generation-fenced session.mutate', async () => {
      const { backend, gateway } = await setup();
      await backend.startSession();
      await settle(80);
      await backend.setSessionModel(SESSION, 'anthropic:claude-y');
      const first = gateway.requests.find((r) => r.method === 'session.mutate')!;
      expect(first.params).toMatchObject({
        session_id: SESSION, operation: 'model', expected_revision: 7, expected_generation: 3,
        payload: { model: 'claude-y', provider: 'anthropic' },
      });
      expect(typeof first.params.request_id).toBe('string');

      await backend.setSessionModel(SESSION, 'anthropic:claude-x');
      const second = gateway.requests.filter((r) => r.method === 'session.mutate')[1]!;
      expect(second.params.expected_revision).toBe(8);
    });

    it('sends an unlisted freeform id as a bare model', async () => {
      const { backend, gateway } = await setup();
      await backend.startSession();
      await backend.setSessionModel(SESSION, 'my-local-model');
      expect(gateway.requests.find((r) => r.method === 'session.mutate')!.params.payload).toEqual({ model: 'my-local-model' });
    });
  });

  describe('connection loss', () => {
    it('fails the in-flight turn, then reattaches and resumes on the next prompt', async () => {
      const { backend, gateway, attach, messages } = await setup();
      await backend.startSession();
      await backend.sendPrompt(SESSION, 'one');
      const completion = backend.waitForResponseComplete!();
      gateway.dropConnections();
      const outcome = await completion;
      expect(outcome).toMatchObject({ kind: 'failed' });
      expect(messages).toContainEqual({ type: 'status', status: 'idle', turnFinished: true });

      await backend.sendPrompt(SESSION, 'two');
      expect(attach.calls).toHaveLength(2);
      expect(gateway.requests.filter((r) => r.method === 'session.resume')).toHaveLength(1);
      expect(gateway.requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(2);
    });
  });
});
