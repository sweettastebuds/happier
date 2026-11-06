import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { PiRpcBackend } from './PiRpcBackend';

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
        out({ type: 'extension_ui_request', id: 'omp-approval-1', method: 'select',
          title: 'Allow tool: bash\\ncommand: ls', options: ['Approve', 'Approve bash for this session', 'Deny'] });
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
    scenario?: 'approval' | 'question' | 'ask';
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

    expect(handleToolCall).toHaveBeenCalledWith('omp-approval-1', 'bash', expect.objectContaining({ prompt: expect.stringContaining('Allow tool: bash') }));
    expect(h.log().find((e) => e.command?.type === 'extension_ui_response')!.command).toEqual({
      type: 'extension_ui_response', id: 'omp-approval-1', value: 'Approve',
    });
  });

  it('answers Deny for a denied tool approval and the session label for approved_for_session', async () => {
    const denied = createHarness({ permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) } });
    await denied.backend.sendPrompt((await denied.backend.startSession()).sessionId, 'x');
    expect(denied.log().find((e) => e.command?.type === 'extension_ui_response')!.command.value).toBe('Deny');

    const forSession = createHarness({ permissionHandler: { handleToolCall: async () => ({ decision: 'approved_for_session' }) } });
    await forSession.backend.sendPrompt((await forSession.backend.startSession()).sessionId, 'x');
    expect(forSession.log().find((e) => e.command?.type === 'extension_ui_response')!.command.value)
      .toBe('Approve bash for this session');
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
      answers: [{ id: 'q1', selectedOptions: ['Workspace'], customInput: 'and tests' }],
    });
  });
});
