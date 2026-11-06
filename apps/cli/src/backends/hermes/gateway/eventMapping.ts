/**
 * Hermes canonical session events -> Happier `AgentMessage`s.
 *
 * Payload shapes come from Hermes `tui_gateway/contracts/events.py` (6b21d0564de0). The mapper is
 * stateful only where the wire is: streamed deltas carry a per-segment offset so a re-sent chunk is
 * dropped, and a turn whose text never streamed still needs its final text delivered once.
 */
import type { AgentMessage } from '@/agent/core';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';

import type { HermesGatewayEvent } from './HermesGatewayClient';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Stable Happier model id for a Hermes (provider, model) pair. */
export function qualifyHermesModelId(provider: string | null | undefined, model: string | null | undefined): string | null {
  const modelId = typeof model === 'string' ? model.trim() : '';
  if (!modelId) return null;
  const providerId = typeof provider === 'string' ? provider.trim() : '';
  return providerId ? `${providerId}:${modelId}` : modelId;
}

export function readHermesTurnOutcome(payload: Record<string, unknown>): AcpTurnOutcome {
  const status = payload.status;
  if (status === 'interrupted') return { kind: 'aborted', stopReason: 'cancelled' };
  if (status === 'error') {
    return { kind: 'failed', error: new Error(asNonEmptyString(payload.error) ?? 'Hermes turn failed') };
  }
  return { kind: 'completed', stopReason: 'end_turn' };
}

function toTokenCount(sessionId: string | undefined, usageValue: unknown): AgentMessage[] {
  const usage = asRecord(usageValue);
  if (!usage) return [];
  const tokens: Record<string, number> = {};
  const assign = (key: string, source: string): void => {
    const value = finiteNumber(usage[source]);
    if (value !== null && value >= 0) tokens[key] = value;
  };
  assign('input', 'input');
  assign('output', 'output');
  assign('thought', 'reasoning');
  assign('cache_read', 'cache_read');
  assign('cache_creation', 'cache_write');
  assign('total', 'total');
  if (Object.keys(tokens).length === 0) return [];
  const cost = finiteNumber(usage.cost_usd);
  return [{
    type: 'token-count',
    key: `hermes:${sessionId ?? 'session'}`,
    tokens,
    ...(cost !== null && cost >= 0 ? { cost: { total: cost } } : {}),
  }];
}

export function createHermesEventMapper(): (event: HermesGatewayEvent) => AgentMessage[] {
  const appliedBySegment = new Map<string, number>();
  let streamedText = false;
  let streamedReasoning = false;

  const resetTurn = (): void => {
    appliedBySegment.clear();
    streamedText = false;
    streamedReasoning = false;
  };

  return (event) => {
    const payload = event.payload;
    switch (event.type) {
      case 'message.start':
        resetTurn();
        return [{ type: 'status', status: 'running' }];

      case 'message.delta': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text) return [];
        const offset = finiteNumber(payload.offset);
        const key = `${asNonEmptyString(payload.turn_id) ?? ''}:${finiteNumber(payload.segment) ?? 0}`;
        let delta = text;
        if (offset !== null) {
          const applied = appliedBySegment.get(key) ?? 0;
          if (offset + text.length <= applied) return [];
          if (offset < applied) delta = text.slice(applied - offset);
          appliedBySegment.set(key, offset + text.length);
        }
        streamedText = true;
        return [{ type: 'model-output', textDelta: delta }];
      }

      case 'message.interim': {
        const text = asNonEmptyString(payload.text);
        if (!text || payload.already_streamed === true) return [];
        return [{ type: 'model-output', fullText: text, fullTextScope: 'segment' }];
      }

      case 'reasoning.delta':
      case 'thinking.delta': {
        const text = asNonEmptyString(payload.text);
        if (!text) return [];
        streamedReasoning = true;
        return [{ type: 'event', name: 'thinking', payload: { text } }];
      }

      case 'reasoning.available': {
        const text = asNonEmptyString(payload.text);
        if (!text) return [];
        streamedReasoning = true;
        return [{ type: 'event', name: 'thinking', payload: { fullText: text } }];
      }

      case 'tool.start': {
        const callId = asNonEmptyString(payload.tool_id);
        const toolName = asNonEmptyString(payload.name);
        if (!callId || !toolName) return [];
        const args = asRecord(payload.args) ?? (asNonEmptyString(payload.preview) ? { preview: payload.preview } : {});
        return [{ type: 'tool-call', callId, toolName, args }];
      }

      case 'tool.complete': {
        const callId = asNonEmptyString(payload.tool_id);
        const toolName = asNonEmptyString(payload.name);
        if (!callId || !toolName) return [];
        const structured = payload.result ?? null;
        const result = structured ?? asNonEmptyString(payload.result_text) ?? asNonEmptyString(payload.summary) ?? '';
        const isError = typeof asRecord(structured)?.error === 'string';
        const duration = finiteNumber(payload.duration_s);
        const diff = asNonEmptyString(payload.inline_diff);
        const meta = {
          ...(duration !== null ? { durationSeconds: duration } : {}),
          ...(diff ? { inlineDiff: diff } : {}),
        };
        return [{
          type: 'tool-result',
          callId,
          toolName,
          result,
          ...(isError ? { isError: true } : {}),
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        }];
      }

      case 'tool.progress': {
        const callId = asNonEmptyString(payload.tool_id);
        const toolName = asNonEmptyString(payload.name);
        const message = asNonEmptyString(payload.message);
        if (!callId || !toolName || !message) return [];
        return [{ type: 'tool-result', callId, toolName, result: { _stream: true, stdoutChunk: message } }];
      }

      case 'session.usage':
        return toTokenCount(event.session_id, payload.usage);

      case 'message.complete': {
        const messages: AgentMessage[] = [];
        const reasoning = asNonEmptyString(payload.reasoning);
        if (reasoning && !streamedReasoning) messages.push({ type: 'event', name: 'thinking', payload: { fullText: reasoning } });
        const text = asNonEmptyString(payload.text);
        if (text && !streamedText && payload.response_reused !== true) messages.push({ type: 'model-output', fullText: text });
        messages.push(...toTokenCount(event.session_id, payload.usage));
        resetTurn();
        return messages;
      }

      case 'notice': {
        const message = asNonEmptyString(payload.message);
        return message ? [{ type: 'event', name: 'message', payload: { message } }] : [];
      }

      case 'error': {
        const message = asNonEmptyString(payload.message);
        return message ? [{ type: 'event', name: 'message', payload: { message: `Hermes error: ${message}` } }] : [];
      }

      case 'session.info': {
        const modelId = qualifyHermesModelId(asNonEmptyString(payload.provider), asNonEmptyString(payload.model));
        return modelId ? [{ type: 'event', name: 'current_model_update', payload: { currentModelId: modelId } }] : [];
      }

      default:
        return [];
    }
  };
}
