import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { PiRpcBackend } from './PiRpcBackend';

/** The session boundary the real permission handler talks to (agentState + RPC handler registry). */
class FakePermissionSession {
  sessionId = 'omp-test-session';
  agentState: any = { requests: {}, completedRequests: {} };
  handlers = new Map<string, (payload: any) => any>();
  rpcHandlerManager = { registerHandler: (name: string, handler: (payload: any) => any) => { this.handlers.set(name, handler); } };
  getAgentStateSnapshot() { return this.agentState; }
  getMetadataSnapshot() { return null; }
  async updateAgentStateRequestSettlement(updater: (state: any) => any) { this.agentState = updater(this.agentState); }
  updateAgentState(updater: (state: any) => any) { this.agentState = updater(this.agentState); return this.agentState; }
  respond(id: string, decision: string) {
    return this.handlers.get('permission')?.({ id, approved: decision !== 'denied', decision });
  }
}

/**
 * Fake `omp --mode rpc-ui` child. Frame shapes follow oh-my-pi packages/coding-agent/src/modes/rpc
 * (rpc-types.ts, rpc-mode.ts @ f6d0dd7): a `ready` frame first, `get_available_commands`, `set_ask_dialog`,
 * and approval prompts as `select` requests whose options end in `Deny` (tools/approval.ts).
 * Not captured from a live omp run (see lanes/capture.md): the live-run capture was denied.
 */
function writeFakeOmpScript(dir: string): string {
  const script = join(dir, 'fake-omp.js');
  writeFileSync(script, `
const readline = require('node:readline');
const fs = require('node:fs');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (entry) => fs.appendFileSync(process.env.OMP_FAKE_LOG, JSON.stringify(entry) + '\\n');
log({ kind: 'spawn', argv: process.argv.slice(2), env: {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
  PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
  PI_PROFILE: process.env.PI_PROFILE ?? null,
  OMP_PROFILE: process.env.OMP_PROFILE ?? null,
  PI_CONFIG_DIR: process.env.PI_CONFIG_DIR ?? null,
  KEEP_ME: process.env.KEEP_ME ?? null,
} });
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 65536, maxReassembledFrameBytes: 1048576 });
const rl = readline.createInterface({ input: process.stdin });
const scenario = process.env.OMP_FAKE_SCENARIO || 'approval';
let streaming = false;
let approvals = 0;
rl.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  log({ kind: 'command', command });
  if (command.type === 'extension_ui_response') {
    streaming = false;
    out({ type: 'agent_end' });
    return;
  }
  const ok = (data) => out({ id: command.id, type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });
  switch (command.type) {
    case 'set_ask_dialog': ok({ enabled: command.enabled }); break;
    case 'get_state': ok({
      sessionId: process.env.OMP_FAKE_SESSION_ID || 'omp-session-1',
      sessionFile: '/tmp/omp-session-1.jsonl',
      isStreaming: streaming, isCompacting: false, thinkingLevel: 'max',
      model: { id: 'claude-x', provider: 'anthropic', name: 'Claude X' },
    }); break;
    case 'get_available_models': ok({ models: [{ id: 'claude-x', provider: 'anthropic', name: 'Claude X', reasoning: true }] }); break;
    case 'get_available_commands': ok({ commands: [{ name: 'plan', description: 'Plan', source: 'builtin' }] }); break;
    case 'get_commands': out({ id: command.id, type: 'response', command: command.type, success: false, error: 'unknown command' }); break;
    case 'prompt':
      streaming = true;
      ok();
      out({ type: 'agent_start' });
      if (scenario === 'approval') {
        approvals += 1;
        out({ type: 'extension_ui_request', id: 'omp-approval-' + approvals, method: 'select',
          title: process.env.OMP_FAKE_TITLE || 'Allow tool: bash\\nCommand: ls',
          options: process.env.OMP_FAKE_OPTIONS ? JSON.parse(process.env.OMP_FAKE_OPTIONS) : ['Approve', 'Approve bash for this session', 'Deny'] });
      } else if (scenario === 'cancel') {
        out({ type: 'extension_ui_request', id: 'omp-approval-1', method: 'select',
          title: 'Allow tool: bash\\nCommand: ls', options: ['Approve', 'Deny'] });
        setTimeout(() => out({ type: 'extension_ui_request', id: 'cancel-1', method: 'cancel', targetId: 'omp-approval-1' }), 50);
      } else if (scenario === 'question') {
        out({ type: 'extension_ui_request', id: 'omp-question-1', method: 'select',
          title: 'Pick one', options: ['Alpha', 'Beta'] });
      } else if (scenario === 'ask') {
        out({ type: 'extension_ui_request', id: 'omp-ask-1', method: 'ask', questions: [
          { id: 'q1', question: 'Which scope?', options: [{ label: 'Repo' }, { label: 'Workspace' }] },
        ] });
      }
      break;
    default: ok({}); break;
  }
});
`, 'utf8');
  return script;
}

type Harness = Readonly<{ dir: string; log: () => Array<Record<string, any>>; backend: PiRpcBackend; messages: AgentMessage[] }>;

describe('PiRpcBackend omp flavor', () => {
  const tempDirs: string[] = [];
  const backends: PiRpcBackend[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createHarness(options: {
    scenario?: 'approval' | 'cancel' | 'question' | 'ask';
    flavor?: 'omp' | 'pi';
    env?: Record<string, string>;
    args?: string[];
    permissionHandler?: AcpPermissionHandler;
  } = {}): Harness {
    const dir = mkdtempSync(join(tmpdir(), 'happier-omp-rpc-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'log.jsonl');
    const backend = new PiRpcBackend({
      flavor: options.flavor ?? 'omp',
      cwd: dir,
      command: process.execPath,
      args: [writeFakeOmpScript(dir), ...(options.args ?? [])],
      permissionHandler: options.permissionHandler,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1',
        OMP_FAKE_LOG: logPath,
        OMP_FAKE_SCENARIO: options.scenario ?? 'approval',
        ...(options.env ?? {}),
      },
    });
    backends.push(backend);
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => { messages.push(message); });
    const log = () => {
      try {
        return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    };
    return { dir, log, backend, messages };
  }

  const commandTypes = (h: Harness) => h.log().filter((e) => e.kind === 'command').map((e) => e.command.type);

  it('never hands pi agent-dir, session-dir or profile variables to omp, from process or backend env', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/pi/agent');
    vi.stubEnv('PI_PROFILE', 'work');
    vi.stubEnv('KEEP_ME', 'yes');
    const h = createHarness({ env: { PI_CODING_AGENT_SESSION_DIR: '/pi/sessions', OMP_PROFILE: 'p', PI_CONFIG_DIR: '.pi' } });
    await h.backend.startSession();
    const spawn = h.log().find((e) => e.kind === 'spawn')!;
    expect(spawn.env).toEqual({
      PI_CODING_AGENT_DIR: null,
      PI_CODING_AGENT_SESSION_DIR: null,
      PI_PROFILE: null,
      OMP_PROFILE: null,
      PI_CONFIG_DIR: null,
      KEEP_ME: 'yes',
    });
  });

  it('leaves the pi flavor environment untouched', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/pi/agent');
    const h = createHarness({ flavor: 'pi' });
    await h.backend.startSession();
    expect(h.log().find((e) => e.kind === 'spawn')!.env.PI_CODING_AGENT_DIR).toBe('/pi/agent');
  });

  it('tolerates the ready frame, opts in to the ask dialog first, and uses get_available_commands', async () => {
    const h = createHarness();
    await h.backend.startSession();
    await vi.waitFor(() => expect(commandTypes(h)).toContain('get_available_commands'));

    const types = commandTypes(h);
    expect(types[0]).toBe('set_ask_dialog');
    expect(h.log().find((e) => e.kind === 'command' && e.command.type === 'set_ask_dialog')!.command.enabled).toBe(true);
    expect(types).not.toContain('get_commands');
    expect(h.messages).not.toContainEqual(expect.objectContaining({ type: 'terminal-output' }));
    await vi.waitFor(() => expect(h.messages).toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'available_commands_update',
      payload: { availableCommands: [{ name: '/plan', description: 'Plan' }] },
    })));
  });

  it('does not load the pi model-discovery extension and reads the model catalog over RPC', async () => {
    const h = createHarness();
    await h.backend.startSession();
    expect(h.log().find((e) => e.kind === 'spawn')!.argv.join(' ')).not.toContain('--extension');
    await vi.waitFor(() => expect(h.messages).toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'session_models_state',
      payload: expect.objectContaining({
        availableModels: [expect.objectContaining({ id: 'anthropic/claude-x' })],
      }),
    })));
  });

  it('resumes with an explicit --resume <id> (never bare, never pi --session)', async () => {
    const h = createHarness({ args: ['--mode', 'rpc-ui'], env: { OMP_FAKE_SESSION_ID: 'omp-session-9' } });
    await expect(h.backend.loadSession('omp-session-9')).resolves.toEqual({ sessionId: 'omp-session-9' });
    const argv = h.log().find((e) => e.kind === 'spawn')!.argv as string[];
    const at = argv.indexOf('--resume');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('omp-session-9');
    expect(argv).not.toContain('--session');
  });

  it('answers a Deny-terminated select during a turn as a tool permission request with the exact option label', async () => {
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(async () => ({ decision: 'approved' }));
    const h = createHarness({ permissionHandler: { handleToolCall } });
    const session = await h.backend.startSession();
    await h.backend.sendPrompt(session.sessionId, 'list files');

    expect(handleToolCall).toHaveBeenCalledWith(
      'omp-approval-1',
      'bash',
      expect.objectContaining({ command: 'ls', prompt: expect.stringContaining('Allow tool: bash') }),
      undefined,
    );
    expect(h.log().find((e) => e.command?.type === 'extension_ui_response')!.command).toEqual({
      type: 'extension_ui_response', id: 'omp-approval-1', value: 'Approve',
    });
  });

  const OMP_SESSION_OPTIONS = JSON.stringify(['Approve Once', 'Approve bash for this session', 'Deny']);
  const responses = (h: Harness) => h.log().filter((e) => e.command?.type === 'extension_ui_response').map((e) => e.command.value);

  it('answers Deny for a denied tool approval and never omp\'s tool-wide session label for approved_for_session', async () => {
    const denied = createHarness({ permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) } });
    await denied.backend.sendPrompt((await denied.backend.startSession()).sessionId, 'x');
    expect(responses(denied)).toEqual(['Deny']);

    const forSession = createHarness({
      env: { OMP_FAKE_OPTIONS: OMP_SESSION_OPTIONS },
      permissionHandler: { handleToolCall: async () => ({ decision: 'approved_for_session' }) },
    });
    await forSession.backend.sendPrompt((await forSession.backend.startSession()).sessionId, 'x');
    expect(responses(forSession)).toEqual(['Approve Once']);
  });

  it('Happier owns session scope per exact command: a repeat is auto-approved with the once label, a different command still prompts (real handler)', async () => {
    const session = new FakePermissionSession();
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Test]' });
    const h = createHarness({ env: { OMP_FAKE_OPTIONS: OMP_SESSION_OPTIONS }, permissionHandler: handler });
    const sessionId = (await h.backend.startSession()).sessionId;
    const first = h.backend.sendPrompt(sessionId, 'x');
    await vi.waitFor(() => expect(session.agentState.requests['omp-approval-1']).toBeTruthy());
    await session.respond('omp-approval-1', 'approved_for_session');
    await first;
    expect(responses(h)).toEqual(['Approve Once']);

    // The identical command never reaches Happier's UI again, and omp is still answered once-only.
    await h.backend.sendPrompt(sessionId, 'x');
    expect(session.agentState.requests['omp-approval-2']).toBeUndefined();
    expect(responses(h)).toEqual(['Approve Once', 'Approve Once']);

    // A different command is not covered by the `ls` grant.
    const next = handler.handleToolCall('omp-approval-3', 'bash', { command: 'rm -rf build', prompt: 'Allow tool: bash\nCommand: rm -rf build' });
    expect(session.agentState.requests['omp-approval-3']).toBeTruthy();
    await session.respond('omp-approval-3', 'denied');
    await next;
  });

  it.each([
    ['a truncated command', 'Allow tool: bash\nCommand: echo aaaa[…4096ch elided…]'],
    ['an edit', 'Allow tool: edit\nFile: /a/c.ts'],
    ['a write', 'Allow tool: write\nPath: /a/b.txt'],
  ])('approves %s once only: no session grant is recorded (real handler)', async (_label, title) => {
    const session = new FakePermissionSession();
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Test]' });
    const h = createHarness({ env: { OMP_FAKE_TITLE: title, OMP_FAKE_OPTIONS: OMP_SESSION_OPTIONS }, permissionHandler: handler });
    const sessionId = (await h.backend.startSession()).sessionId;
    const first = h.backend.sendPrompt(sessionId, 'x');
    await vi.waitFor(() => expect(session.agentState.requests['omp-approval-1']).toBeTruthy());
    await session.respond('omp-approval-1', 'approved_for_session');
    await first;

    const second = h.backend.sendPrompt(sessionId, 'x');
    await vi.waitFor(() => expect(session.agentState.requests['omp-approval-2']).toBeTruthy());
    await session.respond('omp-approval-2', 'denied');
    await second;
    expect(responses(h)).toEqual(['Approve Once', 'Deny']);
  });

  it('never turns a literal command ending in :* into a prefix grant (real handler)', async () => {
    const session = new FakePermissionSession();
    const handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Test]' });
    const h = createHarness({ env: { OMP_FAKE_TITLE: 'Allow tool: bash\nCommand: rm:*', OMP_FAKE_OPTIONS: OMP_SESSION_OPTIONS }, permissionHandler: handler });
    const sessionId = (await h.backend.startSession()).sessionId;
    const first = h.backend.sendPrompt(sessionId, 'x');
    await vi.waitFor(() => expect(session.agentState.requests['omp-approval-1']).toBeTruthy());
    await session.respond('omp-approval-1', 'approved_for_session');
    await first;

    const next = handler.handleToolCall('omp-approval-2', 'bash', { command: 'rm -rf build' });
    expect(session.agentState.requests['omp-approval-2']).toBeTruthy();
    await session.respond('omp-approval-2', 'denied');
    await next;
  });

  it('cancels the pending Happier request on an omp cancel frame and writes no late answer', async () => {
    const cancelPendingRequest = vi.fn<NonNullable<AcpPermissionHandler['cancelPendingRequest']>>(() => true);
    let release!: () => void;
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(
      () => new Promise((resolve) => { release = () => resolve({ decision: 'abort' }); }),
    );
    const h = createHarness({ scenario: 'cancel', permissionHandler: { handleToolCall, cancelPendingRequest } });
    const turn = h.backend.sendPrompt((await h.backend.startSession()).sessionId, 'x');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(cancelPendingRequest).toHaveBeenCalledWith('omp-approval-1', expect.any(String)));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.log().some((e) => e.command?.type === 'extension_ui_response')).toBe(false);
  });

  it('keeps a select without a trailing Deny as a normal question', async () => {
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(async () => ({
      decision: 'approved', answers: { 'Pick one': ['Beta'] },
    }));
    const h = createHarness({ scenario: 'question', permissionHandler: { handleToolCall } });
    await h.backend.sendPrompt((await h.backend.startSession()).sessionId, 'x');
    expect(handleToolCall).toHaveBeenCalledWith('omp-question-1', 'AskUserQuestion', expect.anything());
    expect(h.log().find((e) => e.command?.type === 'extension_ui_response')!.command).toEqual({
      type: 'extension_ui_response', id: 'omp-question-1', value: 'Beta',
    });
  });

  it('answers the structured ask dialog it opted in to', async () => {
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(async () => ({
      decision: 'approved', answers: { 'Which scope?': ['Workspace', 'and tests'] },
    }));
    const h = createHarness({ scenario: 'ask', permissionHandler: { handleToolCall } });
    await h.backend.sendPrompt((await h.backend.startSession()).sessionId, 'x');
    expect(h.log().find((e) => e.command?.type === 'extension_ui_response')!.command).toEqual({
      type: 'extension_ui_response',
      id: 'omp-ask-1',
      // omp rejects a single-select answer carrying both a label and custom text.
      answers: [{ id: 'q1', selectedOptions: ['Workspace'] }],
    });
  });

  it('keeps omp max thinking distinct from xhigh in the published option and set_thinking_level', async () => {
    const h = createHarness();
    const session = await h.backend.startSession();
    await h.backend.waitForSessionModels();
    const latest = () => [...h.messages].reverse().find((m) => m.type === 'event' && (m as any).name === 'session_models_state') as any;
    const option = () => latest().payload.availableModels[0].modelOptions[0];
    expect(option().currentValue).toBe('max');
    expect(option().options.map((o: { value: string }) => o.value)).toContain('max');

    await (h.backend as any).setSessionConfigOption(session.sessionId, 'reasoning_effort', 'max');
    expect(h.log().filter((e) => e.command?.type === 'set_thinking_level').map((e) => e.command.level)).toEqual(['max']);
  });
});
