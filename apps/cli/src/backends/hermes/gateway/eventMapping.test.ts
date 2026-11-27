import { describe, expect, it } from 'vitest';

import type { HermesGatewayEvent } from './HermesGatewayClient';
import { createHermesEventMapper, qualifyHermesModelId, readHermesTurnOutcome } from './eventMapping';

// Payload shapes: Hermes tui_gateway/contracts/events.py (6b21d0564de0); not live captures.
function ev(type: string, payload: Record<string, unknown>, extra: Partial<HermesGatewayEvent> = {}): HermesGatewayEvent {
  return { type, session_id: 's1', payload, ...extra };
}

describe('createHermesEventMapper', () => {
  it('maps a streamed turn: start -> deltas -> complete without repeating streamed text', () => {
    const map = createHermesEventMapper();
    expect(map(ev('message.start', {}))).toEqual([{ type: 'status', status: 'running' }]);
    expect(map(ev('message.delta', { text: 'Hel', turn_id: 't1', segment: 0, offset: 0 }))).toEqual([{ type: 'model-output', textDelta: 'Hel' }]);
    expect(map(ev('message.delta', { text: 'lo', turn_id: 't1', segment: 0, offset: 3 }))).toEqual([{ type: 'model-output', textDelta: 'lo' }]);
    const done = map(ev('message.complete', { text: 'Hello', status: 'complete', response_reused: true }));
    expect(done.filter((m) => m.type === 'model-output')).toEqual([]);
  });

  it('drops a re-sent delta and trims an overlapping one using the segment offset', () => {
    const map = createHermesEventMapper();
    map(ev('message.delta', { text: 'Hello', turn_id: 't1', segment: 0, offset: 0 }));
    expect(map(ev('message.delta', { text: 'Hello', turn_id: 't1', segment: 0, offset: 0 }))).toEqual([]);
    expect(map(ev('message.delta', { text: 'lo world', turn_id: 't1', segment: 0, offset: 3 }))).toEqual([{ type: 'model-output', textDelta: ' world' }]);
    // A new segment starts counting from zero again.
    expect(map(ev('message.delta', { text: 'next', turn_id: 't1', segment: 1, offset: 0 }))).toEqual([{ type: 'model-output', textDelta: 'next' }]);
  });

  it('ignores the null-text segment boundary and empty chunks', () => {
    const map = createHermesEventMapper();
    expect(map(ev('message.delta', { text: null }))).toEqual([]);
    expect(map(ev('message.delta', { text: '' }))).toEqual([]);
  });

  it('delivers the final text when the provider never streamed it', () => {
    const map = createHermesEventMapper();
    map(ev('message.start', {}));
    const done = map(ev('message.complete', { text: 'All done', status: 'complete' }));
    expect(done).toContainEqual({ type: 'model-output', fullText: 'All done' });
  });

  it('maps interim commentary only when it was not already streamed', () => {
    const map = createHermesEventMapper();
    expect(map(ev('message.interim', { text: 'checking', already_streamed: true }))).toEqual([]);
    expect(map(ev('message.interim', { text: 'checking', already_streamed: false }))).toEqual([
      { type: 'model-output', fullText: 'checking', fullTextScope: 'segment' },
    ]);
  });

  it('maps reasoning as thinking events', () => {
    const map = createHermesEventMapper();
    expect(map(ev('reasoning.delta', { text: 'hmm' }))).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'hmm' } }]);
    expect(map(ev('reasoning.available', { text: 'full thought' }))).toEqual([{ type: 'event', name: 'thinking', payload: { fullText: 'full thought' } }]);
  });

  it('maps tool.start/tool.complete to tool-call/tool-result with the same call id', () => {
    const map = createHermesEventMapper();
    expect(map(ev('tool.start', { tool_id: 'c1', name: 'terminal', args: { command: 'ls' } }))).toEqual([
      { type: 'tool-call', callId: 'c1', toolName: 'terminal', args: { command: 'ls' } },
    ]);
    expect(map(ev('tool.complete', { tool_id: 'c1', name: 'terminal', result: { output: 'a b' }, duration_s: 0.2 }))).toEqual([
      { type: 'tool-result', callId: 'c1', toolName: 'terminal', result: { output: 'a b' }, meta: { durationSeconds: 0.2 } },
    ]);
  });

  it('flags a tool result that carries an error and keeps the inline diff', () => {
    const map = createHermesEventMapper();
    const [result] = map(ev('tool.complete', { tool_id: 'c2', name: 'patch', result: { error: 'no such file' }, inline_diff: '--- a\n+++ b' }));
    expect(result).toMatchObject({ type: 'tool-result', callId: 'c2', isError: true, meta: { inlineDiff: '--- a\n+++ b' } });
  });

  it('falls back to the text summary when a tool result is not structured', () => {
    const map = createHermesEventMapper();
    const [result] = map(ev('tool.complete', { tool_id: 'c3', name: 'x', result: null, result_text: 'plain output' }));
    expect(result).toMatchObject({ result: 'plain output' });
  });

  it('streams tool progress as a chunk result', () => {
    const map = createHermesEventMapper();
    expect(map(ev('tool.progress', { tool_id: 'c1', name: 'mcp', progress: 1, message: 'step 1' }))).toEqual([
      { type: 'tool-result', callId: 'c1', toolName: 'mcp', result: { _stream: true, stdoutChunk: 'step 1' } },
    ]);
  });

  it('reports cumulative session usage under one stable key', () => {
    const map = createHermesEventMapper();
    const usage = { input: 10, output: 5, reasoning: 2, cache_read: 3, cache_write: 1, total: 21, cost_usd: 0.01 };
    expect(map(ev('session.usage', { usage }))).toEqual([{
      type: 'token-count',
      key: 'hermes:s1',
      tokens: { input: 10, output: 5, thought: 2, cache_read: 3, cache_creation: 1, total: 21 },
      cost: { total: 0.01 },
    }]);
    expect(map(ev('message.complete', { text: '', status: 'complete', usage })).filter((m) => m.type === 'token-count')).toHaveLength(1);
  });

  it('surfaces notices and session-level errors as user-visible messages', () => {
    const map = createHermesEventMapper();
    expect(map(ev('notice', { message: 'capabilities refreshed' }))).toEqual([{ type: 'event', name: 'message', payload: { message: 'capabilities refreshed' } }]);
    expect(map(ev('error', { message: 'agent init failed' }))).toEqual([{ type: 'event', name: 'message', payload: { message: 'Hermes error: agent init failed' } }]);
  });

  it('publishes the live model from session.info', () => {
    const map = createHermesEventMapper();
    expect(map(ev('session.info', { model: 'claude-x', provider: 'anthropic' }))).toEqual([
      { type: 'event', name: 'current_model_update', payload: { currentModelId: 'anthropic:claude-x' } },
    ]);
    expect(map(ev('session.info', { model: '' }))).toEqual([]);
  });

  it('ignores event types it does not understand', () => {
    expect(createHermesEventMapper()(ev('pet.update', { x: 1 }))).toEqual([]);
  });
});

describe('readHermesTurnOutcome', () => {
  it('maps terminal turn statuses to turn outcomes', () => {
    expect(readHermesTurnOutcome({ status: 'complete' })).toEqual({ kind: 'completed', stopReason: 'end_turn' });
    expect(readHermesTurnOutcome({})).toEqual({ kind: 'completed', stopReason: 'end_turn' });
    expect(readHermesTurnOutcome({ status: 'interrupted' })).toEqual({ kind: 'aborted', stopReason: 'cancelled' });
    const failed = readHermesTurnOutcome({ status: 'error', error: 'provider 500' });
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && failed.error.message).toBe('provider 500');
  });
});

describe('qualifyHermesModelId', () => {
  it('joins provider and model and tolerates a missing provider', () => {
    expect(qualifyHermesModelId('anthropic', 'claude-x')).toBe('anthropic:claude-x');
    expect(qualifyHermesModelId('', 'm')).toBe('m');
    expect(qualifyHermesModelId(null, '')).toBeNull();
  });
});
