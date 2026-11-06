/**
 * WebSocket client for Hermes' canonical `hermes-gateway-v1` session wire.
 *
 * One client = one connection = one single-use ticket. It owns request/response correlation,
 * the handshake (ready, client.capabilities, runtime.describe), the heartbeat and event fan-out.
 * Session semantics live in `HermesGatewayBackend`; reconnecting means attaching again.
 *
 * Contract source: Hermes `tui_gateway/ws.py`, `hermes_cli/gateway_client.py`,
 * `tui_gateway/contracts/*` (6b21d0564de0).
 */
// Bun's built-in `ws` ignores several options; the npm alias keeps the real library and a static
// import includes it in standalone binaries (same reason as the Codex app-server client).
import WebSocket from 'ws-node';

import { logger } from '@/ui/logger';

import type { HermesGatewayAttachment } from './attach';

export const HERMES_GATEWAY_PROTOCOL = 'hermes-gateway-v1';
const HERMES_RUNTIME_PROTOCOL = 1;
const REQUIRED_CAPABILITIES = ['durable-admission-v1', 'event-replay-v1'] as const;

/** Mirrors the Codex app-server client's ordinary-request budget; Hermes' own heartbeat values below. */
export const HERMES_GATEWAY_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Hermes' shared gateway client pings every 15 s and drops a socket silent for 45 s (apps/shared json-rpc-channel). */
export const HERMES_GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const HERMES_GATEWAY_HEARTBEAT_DEADLINE_MS = 45_000;

export type HermesGatewayConnectErrorKind =
  | 'connection_failed'
  | 'handshake_timeout'
  | 'subprotocol_mismatch'
  | 'incompatible_runtime'
  | 'missing_capability';

export class HermesGatewayConnectError extends Error {
  readonly kind: HermesGatewayConnectErrorKind;
  constructor(kind: HermesGatewayConnectErrorKind, message: string) {
    super(message);
    this.name = 'HermesGatewayConnectError';
    this.kind = kind;
  }
}

export class HermesGatewayRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'HermesGatewayRpcError';
    this.code = code;
    this.data = data;
  }
}

export class HermesGatewayTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Hermes gateway request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'HermesGatewayTimeoutError';
  }
}

export class HermesGatewayConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`Hermes gateway connection closed: ${reason}`);
    this.name = 'HermesGatewayConnectionClosedError';
  }
}

function createAbortError(): Error {
  return Object.assign(new Error('Hermes gateway request aborted'), { name: 'AbortError' });
}

export type HermesGatewayEvent = Readonly<{
  type: string;
  session_id?: string;
  payload: Record<string, unknown>;
  seq?: number;
  replay_epoch?: string;
  authority_epoch?: number;
  execution_generation?: number;
  admission_id?: string;
}>;

export type HermesGatewayRuntimeDescription = Readonly<{
  instance_id: string;
  profile_id: string;
  authority_epoch: number;
  capabilities: readonly string[];
  session_create: Readonly<{ sources: readonly string[]; parameters: readonly string[] }>;
}>;

export type HermesGatewayRequestOptions = Readonly<{
  /** `null` keeps a side-effecting admission pending until it settles or the connection closes. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}>;

export type HermesGatewayClient = Readonly<{
  attachment: HermesGatewayAttachment;
  runtime: HermesGatewayRuntimeDescription;
  request: <T = unknown>(method: string, params?: object, options?: HermesGatewayRequestOptions) => Promise<T>;
  onEvent: (handler: (event: HermesGatewayEvent) => void) => () => void;
  /** Called once when the connection ends; the error is null for a deliberate `close()`. */
  onClose: (handler: (error: Error | null) => void) => () => void;
  close: () => Promise<void>;
}>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseRuntimeDescription(value: unknown): HermesGatewayRuntimeDescription | null {
  const record = asRecord(value);
  const create = asRecord(record?.session_create);
  if (!record || !create) return null;
  const strings = (v: unknown): string[] | null => Array.isArray(v) && v.every((item) => typeof item === 'string') ? v as string[] : null;
  const capabilities = strings(record.capabilities);
  const sources = strings(create.sources);
  const parameters = strings(create.parameters);
  if (typeof record.instance_id !== 'string' || typeof record.profile_id !== 'string' || !capabilities || !sources || !parameters) return null;
  return {
    instance_id: record.instance_id,
    profile_id: record.profile_id,
    authority_epoch: typeof record.authority_epoch === 'number' ? record.authority_epoch : 0,
    capabilities,
    session_create: { sources, parameters },
  };
}

export async function connectHermesGatewayClient(options: Readonly<{
  /** Runs `hermes gateway attach --json`; called exactly once per connect (tickets are single-use). */
  attach: () => Promise<HermesGatewayAttachment>;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatDeadlineMs?: number;
  signal?: AbortSignal;
}>): Promise<HermesGatewayClient> {
  const requestTimeoutMs = options.requestTimeoutMs ?? HERMES_GATEWAY_DEFAULT_REQUEST_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HERMES_GATEWAY_HEARTBEAT_INTERVAL_MS;
  const heartbeatDeadlineMs = options.heartbeatDeadlineMs ?? HERMES_GATEWAY_HEARTBEAT_DEADLINE_MS;

  const attachment = await options.attach();
  if (attachment.runtimeProtocol !== null && attachment.runtimeProtocol !== HERMES_RUNTIME_PROTOCOL) {
    throw new HermesGatewayConnectError('incompatible_runtime', `This Hermes gateway speaks runtime protocol ${attachment.runtimeProtocol}, Happier supports ${HERMES_RUNTIME_PROTOCOL}. Update Hermes or Happier.`);
  }

  const ws = new WebSocket(attachment.url, [...attachment.protocols], { perMessageDeflate: false });

  const pending = new Map<number, PendingRequest>();
  const eventHandlers = new Set<(event: HermesGatewayEvent) => void>();
  const closeHandlers = new Set<(error: Error | null) => void>();
  let nextId = 1;
  let closed = false;
  let lastInboundAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const finish = (error: Error | null): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    const failure = error ?? new HermesGatewayConnectionClosedError('closed by Happier');
    for (const entry of [...pending.values()]) {
      entry.cleanup();
      entry.reject(failure);
    }
    pending.clear();
    try { ws.terminate(); } catch { /* socket already gone */ }
    for (const handler of [...closeHandlers]) {
      try { handler(error); } catch (handlerError) { logger.debug('[hermes] gateway close handler failed', handlerError); }
    }
  };

  const sendFrame = (frame: unknown): void => {
    if (closed || ws.readyState !== WebSocket.OPEN) throw new HermesGatewayConnectionClosedError('socket is not open');
    ws.send(JSON.stringify(frame));
  };

  const request = <T = unknown>(method: string, params: object = {}, opts: HermesGatewayRequestOptions = {}): Promise<T> => {
    if (closed) return Promise.reject(new HermesGatewayConnectionClosedError('connection already closed'));
    if (opts.signal?.aborted) return Promise.reject(createAbortError());
    const id = nextId++;
    const timeoutMs = opts.timeoutMs === undefined ? requestTimeoutMs : opts.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => {
        pending.delete(id);
        cleanup();
        reject(createAbortError());
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          pending.delete(id);
          cleanup();
          reject(new HermesGatewayTimeoutError(method, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, cleanup });
      try {
        sendFrame({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  let resolveReady!: (payload: Record<string, unknown>) => void;
  const ready = new Promise<Record<string, unknown>>((resolve) => { resolveReady = resolve; });

  const handleMessage = (data: WebSocket.RawData): void => {
    lastInboundAt = Date.now();
    let frame: Record<string, unknown> | null;
    try {
      frame = asRecord(JSON.parse(data.toString()));
    } catch {
      logger.debug('[hermes] ignoring non-JSON gateway frame');
      return;
    }
    if (!frame) return;

    if (frame.method === 'event') {
      const params = asRecord(frame.params);
      if (!params || typeof params.type !== 'string') return;
      const payload = asRecord(params.payload) ?? {};
      if (params.type === 'gateway.ready') {
        resolveReady(payload);
        return;
      }
      const event: HermesGatewayEvent = {
        type: params.type,
        ...(typeof params.session_id === 'string' ? { session_id: params.session_id } : {}),
        payload,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        ...(typeof params.replay_epoch === 'string' ? { replay_epoch: params.replay_epoch } : {}),
        ...(typeof params.authority_epoch === 'number' ? { authority_epoch: params.authority_epoch } : {}),
        ...(typeof params.execution_generation === 'number' ? { execution_generation: params.execution_generation } : {}),
        ...(typeof params.admission_id === 'string' ? { admission_id: params.admission_id } : {}),
      };
      for (const handler of [...eventHandlers]) {
        try { handler(event); } catch (error) { logger.debug('[hermes] gateway event handler failed', error); }
      }
      return;
    }

    if (typeof frame.method === 'string' && frame.id !== undefined) {
      // Server-to-client request (sudo, secret, desktop bridges). Happier answers none of them, and
      // an explicit refusal lets the agent fail fast instead of waiting out its deadline.
      try {
        sendFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `Happier does not handle "${frame.method}"` } });
      } catch { /* connection ended */ }
      return;
    }

    if (typeof frame.id === 'number') {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      entry.cleanup();
      const error = asRecord(frame.error);
      if (error) {
        entry.reject(new HermesGatewayRpcError(typeof error.code === 'number' ? error.code : -32000, typeof error.message === 'string' ? error.message : 'Hermes gateway error', error.data));
      } else {
        entry.resolve(frame.result);
      }
    }
  };

  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error: Error) => reject(error));
    ws.once('close', () => reject(new Error('socket closed before the upgrade completed')));
  });
  ws.on('message', handleMessage);
  ws.on('error', (error: Error) => finish(new HermesGatewayConnectionClosedError(error.message)));
  ws.on('close', (code: number) => finish(new HermesGatewayConnectionClosedError(`socket closed (${code})`)));

  const abortConnect = (): void => finish(createAbortError());
  options.signal?.addEventListener('abort', abortConnect, { once: true });

  const failConnect = (error: unknown): never => {
    finish(error instanceof Error ? error : new Error(String(error)));
    throw error;
  };

  try {
    await opened;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failConnect(/subprotocol/i.test(message)
      ? new HermesGatewayConnectError('subprotocol_mismatch', `The Hermes gateway did not negotiate ${HERMES_GATEWAY_PROTOCOL} (${message}). Update Hermes.`)
      : new HermesGatewayConnectError('connection_failed', `Could not connect to the Hermes gateway: ${message}`));
  }
  if (ws.protocol !== HERMES_GATEWAY_PROTOCOL) {
    failConnect(new HermesGatewayConnectError('subprotocol_mismatch', `The Hermes gateway negotiated "${ws.protocol}" instead of ${HERMES_GATEWAY_PROTOCOL}. Update Hermes.`));
  }

  let readyPayload: Record<string, unknown>;
  try {
    readyPayload = await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new HermesGatewayConnectError('handshake_timeout', 'The Hermes gateway did not send gateway.ready in time.')), requestTimeoutMs);
        timer.unref?.();
        void ready.then(() => clearTimeout(timer));
      }),
    ]);
  } catch (error) {
    return failConnect(error);
  }

  if (readyPayload.heartbeat === true && heartbeatIntervalMs > 0) {
    heartbeat = setInterval(() => {
      if (Date.now() - lastInboundAt > heartbeatDeadlineMs) {
        finish(new HermesGatewayConnectionClosedError('heartbeat deadline passed with no inbound frame'));
        return;
      }
      void request('gateway.ping', {}, { timeoutMs: null }).catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
  }

  try {
    // Advertise that server requests are answered (sudo/secret are refused above). A canonical-only
    // owner may not serve this legacy verb; its absence is not a handshake failure.
    await request('client.capabilities', { server_requests: true }).catch((error: unknown) => {
      if (error instanceof HermesGatewayRpcError) {
        logger.debug(`[hermes] client.capabilities not accepted (${error.code}); continuing`);
        return;
      }
      throw error;
    });
    const runtime = parseRuntimeDescription(await request('runtime.describe'));
    if (!runtime) throw new HermesGatewayConnectError('incompatible_runtime', 'The Hermes gateway returned an unrecognized runtime.describe result. Update Hermes or Happier.');
    const advertised = new Set([...runtime.capabilities, ...attachment.capabilities]);
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !advertised.has(capability));
    if (missing.length > 0) {
      throw new HermesGatewayConnectError('missing_capability', `This Hermes gateway lacks required capabilities (${missing.join(', ')}). Update Hermes and restart your gateway.`);
    }
    options.signal?.removeEventListener('abort', abortConnect);

    return {
      attachment,
      runtime,
      request,
      onEvent: (handler) => { eventHandlers.add(handler); return () => { eventHandlers.delete(handler); }; },
      onClose: (handler) => { closeHandlers.add(handler); return () => { closeHandlers.delete(handler); }; },
      close: async () => { finish(null); },
    };
  } catch (error) {
    return failConnect(error);
  }
}
