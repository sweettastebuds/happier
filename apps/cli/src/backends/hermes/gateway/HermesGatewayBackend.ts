/**
 * Happier `AgentBackend` for Hermes Agent over the canonical `hermes-gateway-v1` WebSocket wire.
 *
 * Happier is a viewer of a gateway the user already runs: it attaches (never starts) per connection,
 * creates or resumes a gateway-owned session, submits prompts as durable admissions and answers
 * approvals/questions through the shared permission flow. Execution lives in Hermes and survives a
 * Happier disconnect; reconnecting is attach + `session.resume`.
 *
 * Session creation `source` is chosen from `runtime.describe` (`tui` first: the terminal-client
 * policy with the coding posture and a session Hermes' own pickers can resume, `cli` second).
 *
 * Contract source: Hermes `tui_gateway/contracts/*`, `gateway/session_*` (6b21d0564de0).
 */
import { randomUUID } from 'node:crypto';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { abortPendingAcpPermissionRequests } from '@/agent/acp/backend/permissions/acpPermissionFinalization';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  AgentSessionOpenOptions,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import type { PermissionResult } from '@/agent/permissions/permissionResult';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { logger } from '@/ui/logger';

import {
  attachHermesGateway,
  HermesGatewayUnavailableError,
  type HermesCommandRunner,
  type HermesGatewayAttachment,
} from './attach';
import { createHermesEventMapper, qualifyHermesModelId, readHermesTurnOutcome } from './eventMapping';
import {
  connectHermesGatewayClient,
  HermesGatewayConnectError,
  type HermesGatewayClient,
  type HermesGatewayEvent,
  type HermesGatewayRuntimeDescription,
} from './HermesGatewayClient';
import { runHermesCommand } from './runHermesCommand';

const SESSION_SOURCES_IN_ORDER = ['tui', 'cli'] as const;

/** Where a session must run: Hermes profile name for `-p`, and the owner identity it must resolve to. */
export type HermesProfileBinding = Readonly<{
  /** `-p` name; null attaches to Hermes' active profile. */
  name: string | null;
  /** Owner-side profile identity recorded with the session; a resume must attach to exactly this. */
  expectedProfileId: string | null;
}>;

export type HermesBoundProfile = Readonly<{
  profileId: string;
  /** Usable `-p` name, when one is known. */
  name: string | null;
}>;

export interface HermesGatewayBackendOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  profile?: HermesProfileBinding;
  permissionHandler?: AcpPermissionHandler;
  /** Called once the owning profile is known so the session can persist it for resume. */
  onProfileBound?: (profile: HermesBoundProfile) => void | Promise<void>;
  /** Boundary overrides (tests): the hermes executable and how it is run. */
  resolveLaunch?: () => Readonly<{ command: string; args: readonly string[] }>;
  runCommand?: HermesCommandRunner;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatDeadlineMs?: number;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type TurnState = {
  deferred: Deferred<AcpTurnOutcome>;
  admissionId: string | null;
  queued: boolean;
};

type SessionSnapshot = Readonly<{
  sessionId: string;
  revision: number;
  executionGeneration: number;
  prompts: ReadonlyArray<Record<string, unknown>>;
  info: Record<string, unknown>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseSnapshot(value: unknown): SessionSnapshot {
  const record = asRecord(value);
  const sessionId = asNonEmptyString(record?.session_id);
  if (!record || !sessionId) throw new Error('Hermes returned an unrecognized session snapshot. Update Hermes or Happier.');
  return {
    sessionId,
    revision: finiteNumber(record.revision) ?? 0,
    executionGeneration: finiteNumber(record.execution_generation) ?? 0,
    prompts: Array.isArray(record.prompts) ? record.prompts.filter((p): p is Record<string, unknown> => asRecord(p) !== null) : [],
    info: asRecord(record.info) ?? {},
  };
}

/** Hermes reports the generic name "custom" for a home outside `~/.hermes/profiles`; it is not a valid `-p` value. */
function usableProfileName(value: unknown): string | null {
  const name = asNonEmptyString(value);
  return name && name !== 'custom' ? name : null;
}

function chooseSessionSource(runtime: HermesGatewayRuntimeDescription): string {
  const offered = new Set(runtime.session_create.sources);
  const source = SESSION_SOURCES_IN_ORDER.find((candidate) => offered.has(candidate));
  if (!source) {
    throw new HermesGatewayConnectError('incompatible_runtime', `This Hermes gateway offers no terminal-client session source (${[...offered].join(', ') || 'none'}). Update Hermes and restart your gateway.`);
  }
  return source;
}

/** Fail closed: a choice is only ever one the prompt offered, and broader grants degrade to the nearest narrower one. */
function chooseApprovalChoice(decision: PermissionResult['decision'], offered: readonly string[]): string {
  const pick = (...candidates: string[]): string => candidates.find((c) => offered.includes(c)) ?? 'deny';
  switch (decision) {
    case 'approved': return pick('once');
    case 'approved_for_session':
    case 'approved_execpolicy_amendment': return pick('session', 'once');
    default: return 'deny';
  }
}

export class HermesGatewayBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly turnEventHandlers = new Set<() => void>();
  private readonly mapEvent = createHermesEventMapper();
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly lifecycle = new AbortController();

  private client: HermesGatewayClient | null = null;
  private connecting: Promise<HermesGatewayClient> | null = null;
  private sessionClient: HermesGatewayClient | null = null;
  private reattaching: Promise<HermesGatewayClient> | null = null;
  private sessionId: string | null = null;
  private revision = 0;
  private executionGeneration = 0;
  private currentModelId: string | null = null;
  private modelIndex = new Map<string, Readonly<{ provider: string; model: string }>>();
  private turn: TurnState | null = null;
  private lastOutcome: AcpTurnOutcome | null = null;
  private seenPromptIds = new Set<string>();
  private settledPromptIds = new Set<string>();
  private driftNoticeShown = false;
  private disposed = false;

  constructor(private readonly options: HermesGatewayBackendOptions) {
    this.processEnv = { ...process.env, ...(options.env ?? {}) };
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  onProviderTurnEvent(handler: () => void): () => void {
    this.turnEventHandlers.add(handler);
    return () => { this.turnEventHandlers.delete(handler); };
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  async startSession(initialPrompt?: string, options?: AgentSessionOpenOptions): Promise<StartSessionResult> {
    const client = await this.connect(options?.signal);
    const raw = await client.request('session.create', {
      request_id: randomUUID(),
      source: chooseSessionSource(client.runtime),
      cwd: this.options.cwd,
    }, { timeoutMs: null, signal: options?.signal });
    const snapshot = parseSnapshot(raw);
    await this.adoptSnapshot(client, snapshot);
    if (initialPrompt) await this.sendPrompt(snapshot.sessionId, initialPrompt);
    return { sessionId: snapshot.sessionId };
  }

  async loadSession(sessionId: SessionId, options?: AgentSessionOpenOptions): Promise<StartSessionResult> {
    const client = await this.connect(options?.signal);
    // Happier already holds the transcript; resume only re-subscribes and returns open prompts.
    const raw = await client.request('session.resume', { session_id: sessionId, omit_messages: true }, { timeoutMs: null, signal: options?.signal });
    const snapshot = parseSnapshot(raw);
    await this.adoptSnapshot(client, snapshot);
    return { sessionId: snapshot.sessionId };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    await abortPendingAcpPermissionRequests(this.options.permissionHandler, 'Hermes backend disposed');
    const client = this.client;
    this.client = null;
    this.sessionClient = null;
    this.finishTurn({ kind: 'aborted', stopReason: 'cancelled' }, false);
    await client?.close();
    this.handlers.clear();
    this.turnEventHandlers.clear();
  }

  // ---- connection ----------------------------------------------------------------------------

  private async attach(): Promise<HermesGatewayAttachment> {
    const launch = this.options.resolveLaunch
      ? this.options.resolveLaunch()
      : requireProviderCliLaunchSpec('hermes', { processEnv: this.processEnv });
    const attachment = await attachHermesGateway({
      launch,
      profile: this.options.profile?.name ?? null,
      env: this.processEnv,
      run: this.options.runCommand ?? runHermesCommand,
      signal: this.lifecycle.signal,
    });
    const expected = this.options.profile?.expectedProfileId ?? null;
    if (expected && attachment.profileId !== expected) {
      throw new HermesGatewayUnavailableError(
        'profile_mismatch',
        `This session belongs to a different Hermes profile than the one now active (${attachment.profileId}). Select the profile it was started with and try again.`,
      );
    }
    return attachment;
  }

  private connect(signal?: AbortSignal): Promise<HermesGatewayClient> {
    if (this.disposed) return Promise.reject(new Error('Hermes backend is disposed'));
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      try {
        const client = await connectHermesGatewayClient({
          attach: () => this.attach(),
          requestTimeoutMs: this.options.requestTimeoutMs,
          heartbeatIntervalMs: this.options.heartbeatIntervalMs,
          heartbeatDeadlineMs: this.options.heartbeatDeadlineMs,
          signal: signal ?? this.lifecycle.signal,
        });
        this.client = client;
        client.onEvent((event) => this.handleEvent(event));
        client.onClose((error) => this.handleConnectionClosed(client, error));
        if (client.attachment.codeDrift && !this.driftNoticeShown) {
          this.driftNoticeShown = true;
          this.emit({ type: 'event', name: 'message', payload: { message: 'Hermes was updated after your gateway started. Restart your Hermes gateway to run the new version.' } });
        }
        return client;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private handleConnectionClosed(client: HermesGatewayClient, error: Error | null): void {
    if (this.client !== client) return;
    this.client = null;
    this.sessionClient = null;
    this.seenPromptIds.clear();
    this.settledPromptIds.clear();
    void abortPendingAcpPermissionRequests(this.options.permissionHandler, 'Hermes gateway connection closed');
    if (this.disposed) return;
    logger.debug(`[hermes] gateway connection closed: ${error?.message ?? 'closed'}`);
    this.finishTurn({
      kind: 'failed',
      error: new Error('The connection to the Hermes gateway was lost. The turn may still be running in Hermes; send another message to reconnect.'),
    });
  }

  /** Reattach and resume on demand after a dropped connection (tickets are single-use, so attach again). */
  private async ensureSessionConnection(): Promise<HermesGatewayClient> {
    if (this.client && this.sessionClient === this.client) return this.client;
    this.reattaching ??= (async () => {
      try {
        const client = await this.connect();
        if (this.sessionClient !== client && this.sessionId) {
          const raw = await client.request('session.resume', { session_id: this.sessionId, omit_messages: true }, { timeoutMs: null });
          await this.adoptSnapshot(client, parseSnapshot(raw));
        }
        return client;
      } finally {
        this.reattaching = null;
      }
    })();
    return this.reattaching;
  }

  private async adoptSnapshot(client: HermesGatewayClient, snapshot: SessionSnapshot): Promise<void> {
    this.sessionId = snapshot.sessionId;
    this.sessionClient = client;
    this.revision = snapshot.revision;
    this.executionGeneration = snapshot.executionGeneration;

    const requestedName = this.options.profile?.name ?? null;
    await this.options.onProfileBound?.({
      profileId: client.attachment.profileId,
      name: requestedName ?? usableProfileName(snapshot.info.profile_name),
    });

    const modelId = qualifyHermesModelId(asNonEmptyString(snapshot.info.provider), asNonEmptyString(snapshot.info.model));
    if (modelId) {
      this.currentModelId = modelId;
      this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: modelId } });
    }
    for (const prompt of snapshot.prompts) this.handlePrompt(prompt);
    void this.publishModelOptions(client, snapshot.sessionId);
  }

  // ---- prompts and turns ---------------------------------------------------------------------

  private assertSession(sessionId: SessionId): void {
    if (!this.sessionId || sessionId !== this.sessionId) throw new Error('Hermes session was not started');
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.assertSession(sessionId);
    if (!prompt.trim()) throw new Error('Prompt text is blank');
    const client = await this.ensureSessionConnection();

    this.lastOutcome = null;
    const createdTurn = this.turn === null;
    const turn: TurnState = this.turn ?? { deferred: createDeferred<AcpTurnOutcome>(), admissionId: null, queued: false };
    this.turn = turn;
    try {
      const receipt = asRecord(await client.request('prompt.submit', {
        session_id: sessionId,
        submission_id: randomUUID(),
        text: prompt,
      }, { timeoutMs: null }));
      const generation = finiteNumber(receipt?.execution_generation);
      if (generation !== null) this.executionGeneration = generation;
      if (this.turn !== turn) return;
      turn.admissionId = asNonEmptyString(receipt?.admission_id);
      turn.queued = receipt?.status === 'queued';
      if (receipt?.status === 'unknown') {
        throw new Error('Hermes could not confirm this prompt after a gateway restart. Resolve it in Hermes, then try again.');
      }
      if (receipt?.status === 'terminal') this.finishTurn({ kind: 'completed', stopReason: 'end_turn' });
    } catch (error) {
      if (createdTurn && this.turn === turn) this.turn = null;
      throw error;
    }
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.assertSession(sessionId);
    const client = await this.ensureSessionConnection();
    const ack = asRecord(await client.request('session.steer', {
      session_id: sessionId,
      execution_generation: this.executionGeneration,
      text: prompt,
    }));
    if (ack?.status === 'rejected') throw new Error('Hermes did not accept the steering message (no running turn to steer).');
  }

  async cancel(sessionId: SessionId): Promise<void> {
    this.assertSession(sessionId);
    await abortPendingAcpPermissionRequests(this.options.permissionHandler, 'Hermes turn cancelled');
    const client = this.client;
    if (!client) return;
    const turn = this.turn;
    if (turn?.queued && turn.admissionId) {
      await client.request('prompt.cancel', { session_id: sessionId, admission_id: turn.admissionId });
      if (this.turn === turn) this.finishTurn({ kind: 'aborted', stopReason: 'cancelled' });
      return;
    }
    const handle = asRecord(await client.request('session.interrupt', {
      session_id: sessionId,
      execution_generation: this.executionGeneration,
    }));
    const generation = finiteNumber(handle?.execution_generation);
    if (generation !== null) this.executionGeneration = generation;
  }

  /**
   * Resolves with the turn outcome. `AgentBackend` types this `Promise<void>`; the ACP runtime
   * (`AcpRuntimeBackend`) reads the outcome, so it is returned through that wider contract.
   */
  waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    return this.awaitTurnOutcome(timeoutMs) as Promise<unknown> as Promise<void>;
  }

  private awaitTurnOutcome(timeoutMs?: number | null): Promise<AcpTurnOutcome> {
    const pending = this.turn?.deferred.promise
      ?? Promise.resolve(this.lastOutcome ?? { kind: 'completed', stopReason: 'end_turn' } as AcpTurnOutcome);
    if (timeoutMs === undefined || timeoutMs === null) return pending;
    return Promise.race([
      pending,
      new Promise<AcpTurnOutcome>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timed_out', capMs: timeoutMs }), timeoutMs);
        timer.unref?.();
        void pending.finally(() => clearTimeout(timer));
      }),
    ]);
  }

  async compactContext(sessionId: SessionId, command: string): Promise<void> {
    this.assertSession(sessionId);
    const focus = command.replace(/^\/compact\s*/i, '').trim();
    await this.mutate('compress', focus ? { focus } : {});
  }

  private finishTurn(outcome: AcpTurnOutcome, emitIdle = true): void {
    const turn = this.turn;
    this.turn = null;
    this.lastOutcome = outcome;
    if (!turn) return;
    void abortPendingAcpPermissionRequests(this.options.permissionHandler, 'Hermes turn finished');
    if (emitIdle) this.emit({ type: 'status', status: 'idle', turnFinished: true });
    turn.deferred.resolve(outcome);
  }

  // ---- events --------------------------------------------------------------------------------

  private handleEvent(event: HermesGatewayEvent): void {
    if (!this.sessionId || event.session_id !== this.sessionId) return;
    if (event.execution_generation !== undefined) this.executionGeneration = event.execution_generation;

    switch (event.type) {
      case 'approval.request':
      case 'clarify.request':
        this.handlePrompt({ ...event.payload, kind: event.type === 'approval.request' ? 'approval' : 'clarify' });
        return;
      case 'approval.settled':
      case 'clarify.settled': {
        const promptId = asNonEmptyString(event.payload.prompt_id);
        if (promptId) {
          this.settledPromptIds.add(promptId);
          this.options.permissionHandler?.cancelPendingRequest?.(promptId, 'Settled in Hermes');
        }
        return;
      }
      case 'session.info': {
        const revision = finiteNumber(event.payload.revision);
        if (revision !== null) this.revision = revision;
        const generation = finiteNumber(event.payload.execution_generation);
        if (generation !== null) this.executionGeneration = generation;
        const modelId = qualifyHermesModelId(asNonEmptyString(event.payload.provider), asNonEmptyString(event.payload.model));
        if (modelId) this.currentModelId = modelId;
        break;
      }
      case 'message.complete':
        this.completeTurn(event);
        return;
      default:
        break;
    }

    if (/^(message|tool|reasoning|thinking)\./.test(event.type)) {
      for (const handler of [...this.turnEventHandlers]) handler();
    }
    for (const message of this.mapEvent(event)) this.emit(message);
  }

  private completeTurn(event: HermesGatewayEvent): void {
    for (const message of this.mapEvent(event)) this.emit(message);
    const turn = this.turn;
    if (!turn) return;
    // A completion stamped with a different admission belongs to an earlier turn of a busy session.
    if (event.admission_id && turn.admissionId && event.admission_id !== turn.admissionId) return;
    this.finishTurn(readHermesTurnOutcome(event.payload));
  }

  // ---- approvals and questions ---------------------------------------------------------------

  private handlePrompt(prompt: Record<string, unknown>): void {
    const promptId = asNonEmptyString(prompt.prompt_id);
    if (!promptId || this.seenPromptIds.has(promptId)) return;
    this.seenPromptIds.add(promptId);
    if (prompt.kind === 'approval') void this.answerApproval(promptId, prompt);
    else if (prompt.kind === 'clarify') void this.answerClarify(promptId, prompt);
  }

  private async answerApproval(promptId: string, prompt: Record<string, unknown>): Promise<void> {
    const offered = Array.isArray(prompt.choices) ? prompt.choices.filter((c): c is string => typeof c === 'string') : ['once', 'deny'];
    const edit = asRecord(prompt.edit);
    const description = typeof prompt.description === 'string' ? prompt.description : '';
    let choice = 'deny';
    try {
      const handler = this.options.permissionHandler;
      if (handler) {
        const result = await handler.handleToolCall(
          promptId,
          edit ? 'Edit' : 'Bash',
          edit ? { ...edit, description } : { command: typeof prompt.command === 'string' ? prompt.command : '', description },
        );
        choice = chooseApprovalChoice(result.decision, offered);
      }
    } catch (error) {
      logger.debug('[hermes] approval handling failed; denying', error);
    }
    if (this.settledPromptIds.has(promptId)) return;
    await this.respondToPrompt('approval.respond', prompt, promptId, { choice });
  }

  private async answerClarify(promptId: string, prompt: Record<string, unknown>): Promise<void> {
    const choices = Array.isArray(prompt.choices) ? prompt.choices.filter((c): c is string => typeof c === 'string') : [];
    const multiSelect = prompt.multi_select === true;
    let answer = '';
    try {
      const handler = this.options.permissionHandler;
      if (handler) {
        const result = await handler.handleToolCall(promptId, 'AskUserQuestion', {
          questions: [{
            id: promptId,
            question: typeof prompt.question === 'string' ? prompt.question : '',
            header: 'Hermes',
            multiSelect,
            options: choices.map((label) => ({ label, description: '' })),
            ...(choices.length === 0 ? { freeform: { allowEmpty: true } } : {}),
          }],
        });
        if (result.decision.startsWith('approved')) {
          const values = Object.values(result.answers ?? {}).find((v) => v.length > 0) ?? [];
          answer = multiSelect ? JSON.stringify(values) : (values[0] ?? '');
        }
      }
    } catch (error) {
      logger.debug('[hermes] question handling failed; skipping', error);
    }
    if (this.settledPromptIds.has(promptId)) return;
    await this.respondToPrompt('clarify.respond', prompt, promptId, { answer });
  }

  private async respondToPrompt(method: string, prompt: Record<string, unknown>, promptId: string, response: Record<string, string>): Promise<void> {
    const client = this.client;
    if (!client || !this.sessionId) return;
    try {
      await client.request(method, {
        session_id: this.sessionId,
        execution_generation: finiteNumber(prompt.execution_generation) ?? this.executionGeneration,
        prompt_id: promptId,
        ...response,
      });
    } catch (error) {
      logger.debug(`[hermes] ${method} failed`, error);
    }
  }

  // ---- model ---------------------------------------------------------------------------------

  private async publishModelOptions(client: HermesGatewayClient, sessionId: string): Promise<void> {
    try {
      const result = asRecord(await client.request('model.options', { session_id: sessionId }));
      const providers = Array.isArray(result?.providers) ? result.providers : [];
      const available: Array<{ id: string; name: string; description: string }> = [];
      const index = new Map<string, Readonly<{ provider: string; model: string }>>();
      for (const row of providers) {
        const provider = asRecord(row);
        const slug = asNonEmptyString(provider?.slug);
        if (!provider || !slug || provider.authenticated === false || !Array.isArray(provider.models)) continue;
        for (const model of provider.models) {
          if (typeof model !== 'string' || !model) continue;
          const id = `${slug}:${model}`;
          index.set(id, { provider: slug, model });
          available.push({ id, name: model, description: asNonEmptyString(provider.name) ?? slug });
        }
      }
      if (this.disposed || this.sessionId !== sessionId || available.length === 0) return;
      this.modelIndex = index;
      this.emit({
        type: 'event',
        name: 'session_models_state',
        payload: { currentModelId: this.currentModelId ?? available[0]!.id, availableModels: available, observedAt: Date.now() },
      });
    } catch (error) {
      // Optional inventory: the picker simply keeps the current model when the list is unavailable.
      logger.debug('[hermes] model.options unavailable', error);
    }
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    this.assertSession(sessionId);
    const normalized = modelId.trim();
    if (!normalized) return;
    const known = this.modelIndex.get(normalized);
    await this.mutate('model', known ? { model: known.model, provider: known.provider } : { model: normalized });
    this.currentModelId = normalized;
    this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: normalized } });
  }

  private async mutate(operation: string, payload: Record<string, unknown>): Promise<void> {
    const client = await this.ensureSessionConnection();
    const result = asRecord(await client.request('session.mutate', {
      session_id: this.sessionId,
      request_id: randomUUID(),
      expected_revision: this.revision,
      operation,
      payload,
      expected_generation: this.executionGeneration,
    }));
    const revision = finiteNumber(result?.revision);
    if (revision !== null) this.revision = revision;
  }

  // ---- output --------------------------------------------------------------------------------

  private emit(message: AgentMessage): void {
    for (const handler of [...this.handlers]) {
      try { handler(message); } catch (error) { logger.debug('[hermes] message handler failed', error); }
    }
  }
}
