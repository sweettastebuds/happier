/**
 * In-process stand-in for a Hermes `hermes-gateway-v1` WebSocket owner. The network transport is
 * real (a `ws` server on loopback); only the Hermes agent behind it is scripted. Frame shapes follow
 * Hermes `tui_gateway/contracts/{events,canonical,canonical_sessions}.py` and `tui_gateway/ws.py`
 * (commit 6b21d0564de0). No live capture exists, see the lane report.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws-node';

import type { HermesCommandInvocation, HermesCommandRunner, HermesGatewayAttachment } from './attach';

export type FakeGatewayRequestContext = Readonly<{
  id: number | string;
  method: string;
  params: Record<string, unknown>;
  emit: (type: string, sessionId: string | null, payload: Record<string, unknown>, extra?: Record<string, unknown>) => void;
}>;

export type FakeGatewayMethod = (ctx: FakeGatewayRequestContext) => unknown | Promise<unknown>;

export class FakeGatewayRpcFailure extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export type FakeHermesGateway = Readonly<{
  url: string;
  tickets: string[];
  subprotocolRequests: string[][];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  clientResponses: Array<Record<string, unknown>>;
  setMethod: (name: string, handler: FakeGatewayMethod) => void;
  emit: (type: string, sessionId: string | null, payload: Record<string, unknown>, extra?: Record<string, unknown>) => void;
  sendRaw: (frame: unknown) => void;
  sendServerRequest: (id: string, method: string, params: Record<string, unknown>) => void;
  dropConnections: () => void;
  silence: () => void;
  connectionCount: () => number;
  attachment: (overrides?: Partial<HermesGatewayAttachment>) => HermesGatewayAttachment;
  close: () => Promise<void>;
}>;

export const FAKE_RUNTIME_DESCRIPTION = {
  instance_id: 'inst-1',
  profile_id: '/home/u/.hermes',
  authority_epoch: 1,
  capabilities: ['durable-admission-v1', 'event-replay-v1', 'clarify-batch-v1'],
  session_create: { sources: ['cli', 'tui', 'gui', 'acp', 'tool', 'oneshot'], parameters: ['cwd', 'model', 'provider', 'yolo', 'title'] },
};

export async function startFakeHermesGateway(options: Readonly<{
  selectProtocol?: (offered: string[]) => string | false;
  sendReady?: boolean;
  runtime?: Record<string, unknown>;
  methods?: Record<string, FakeGatewayMethod>;
}> = {}): Promise<FakeHermesGateway> {
  const tickets: string[] = [];
  const subprotocolRequests: string[][] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const clientResponses: Array<Record<string, unknown>> = [];
  const sockets = new Set<WebSocket>();
  let silent = false;
  let connections = 0;

  const methods = new Map<string, FakeGatewayMethod>(Object.entries({
    'client.capabilities': () => ({ ok: true }),
    'runtime.describe': () => options.runtime ?? FAKE_RUNTIME_DESCRIPTION,
    ...(options.methods ?? {}),
  }));

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (offered) => {
      const list = [...offered];
      subprotocolRequests.push(list);
      for (const protocol of list) {
        if (protocol.startsWith('hermes-gateway-ticket.')) tickets.push(protocol.slice('hermes-gateway-ticket.'.length));
      }
      const chosen = options.selectProtocol ? options.selectProtocol(list) : 'hermes-gateway-v1';
      return chosen;
    },
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const sendFrame = (socket: WebSocket, frame: unknown): void => {
    if (!silent && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  const broadcast = (frame: unknown): void => { for (const socket of sockets) sendFrame(socket, frame); };
  const eventFrame = (type: string, sessionId: string | null, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    method: 'event',
    params: { type, ...(sessionId ? { session_id: sessionId } : {}), payload, ...extra },
  });
  const emit: FakeHermesGateway['emit'] = (type, sessionId, payload, extra) => broadcast(eventFrame(type, sessionId, payload, extra));

  server.on('connection', (socket) => {
    sockets.add(socket);
    connections += 1;
    socket.once('close', () => sockets.delete(socket));
    if (options.sendReady !== false) {
      sendFrame(socket, eventFrame('gateway.ready', null, { skin: {}, change_events: true, replay_epoch: 'epoch-1', heartbeat: true, session_authority: true }));
    }
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof frame.method !== 'string') {
        clientResponses.push(frame);
        return;
      }
      const id = frame.id as number | string;
      const params = (frame.params ?? {}) as Record<string, unknown>;
      if (frame.method === 'gateway.ping') {
        sendFrame(socket, { jsonrpc: '2.0', id, result: { ok: true } });
        return;
      }
      requests.push({ method: frame.method, params });
      const handler = methods.get(frame.method);
      if (!handler) {
        sendFrame(socket, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown_method' } });
        return;
      }
      void Promise.resolve()
        .then(() => handler({ id, method: frame.method as string, params, emit }))
        .then((result) => sendFrame(socket, { jsonrpc: '2.0', id, result }))
        .catch((error: unknown) => {
          const failure = error instanceof FakeGatewayRpcFailure ? error : new FakeGatewayRpcFailure(-32000, String(error));
          sendFrame(socket, { jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message, data: failure.data } });
        });
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/api/ws`,
    tickets,
    subprotocolRequests,
    requests,
    clientResponses,
    setMethod: (name, handler) => { methods.set(name, handler); },
    emit,
    sendRaw: broadcast,
    sendServerRequest: (id, method, params) => broadcast({ jsonrpc: '2.0', id, method, params }),
    dropConnections: () => { for (const socket of sockets) socket.terminate(); },
    silence: () => { silent = true; },
    connectionCount: () => connections,
    attachment: (overrides) => ({
      url: `ws://127.0.0.1:${port}/api/ws`,
      ticket: `ticket-${connections + 1}`,
      protocol: 'hermes-gateway-v1',
      protocols: ['hermes-gateway-v1', `hermes-gateway-ticket.ticket-${connections + 1}`],
      profileId: '/home/u/.hermes',
      instanceId: 'inst-1',
      runtimeProtocol: 1,
      capabilities: ['durable-admission-v1', 'event-replay-v1'],
      codeSha: 'sha-1',
      clientCodeSha: 'sha-1',
      codeDrift: false,
      ...overrides,
    }),
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * `hermes gateway attach --json` boundary fake: answers with the verdict shape of
 * `hermes_cli/gateway_runtime_cli.py::cmd_gateway_attach`, minting a fresh ticket per call.
 */
export function createFakeAttachRunner(gateway: FakeHermesGateway, options: Readonly<{
  profileId?: string;
  codeSha?: string;
  clientCodeSha?: string;
  failWith?: Readonly<{ exitCode: number; stdout?: string }>;
}> = {}): Readonly<{ run: HermesCommandRunner; calls: HermesCommandInvocation[] }> {
  const calls: HermesCommandInvocation[] = [];
  let tickets = 0;
  const run: HermesCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (options.failWith) return { exitCode: options.failWith.exitCode, stdout: options.failWith.stdout ?? '', stderr: '' };
    tickets += 1;
    const ticket = `fake-ticket-${tickets}`;
    const base = gateway.attachment();
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        state: 'ready',
        endpoint: {
          profile_id: options.profileId ?? base.profileId,
          instance_id: 'inst-1',
          runtime_protocol: 1,
          capabilities: ['durable-admission-v1', 'event-replay-v1'],
          code_sha: options.codeSha ?? 'sha-1',
        },
        client_code_sha: options.clientCodeSha ?? options.codeSha ?? 'sha-1',
        url: base.url,
        protocol: 'hermes-gateway-v1',
        protocols: ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`],
        ticket,
      }),
    };
  };
  return { run, calls };
}
