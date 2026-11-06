import { afterEach, describe, expect, it } from 'vitest';

import {
  connectHermesGatewayClient,
  HermesGatewayConnectError,
  HermesGatewayRpcError,
  type HermesGatewayEvent,
} from './HermesGatewayClient';
import { FakeGatewayRpcFailure, startFakeHermesGateway, type FakeHermesGateway } from './fakeHermesGateway.testkit';

describe('connectHermesGatewayClient', () => {
  const gateways: FakeHermesGateway[] = [];
  const clients: Array<{ close: () => Promise<void> }> = [];

  async function gateway(options?: Parameters<typeof startFakeHermesGateway>[0]) {
    const g = await startFakeHermesGateway(options);
    gateways.push(g);
    return g;
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(gateways.splice(0).map((g) => g.close()));
  });

  async function connect(g: FakeHermesGateway, extra: Partial<Parameters<typeof connectHermesGatewayClient>[0]> = {}) {
    const client = await connectHermesGatewayClient({ attach: async () => g.attachment(), ...extra });
    clients.push(client);
    return client;
  }

  it('dials with the ticket subprotocols, then handshakes: ready, client.capabilities, runtime.describe', async () => {
    const g = await gateway();
    const client = await connect(g);

    expect(g.subprotocolRequests[0]).toEqual(['hermes-gateway-v1', 'hermes-gateway-ticket.ticket-1']);
    expect(g.tickets).toEqual(['ticket-1']);
    expect(g.requests.map((r) => r.method)).toEqual(['client.capabilities', 'runtime.describe']);
    expect(g.requests[0]!.params).toEqual({ server_requests: true });
    expect(client.runtime.session_create.sources).toContain('tui');
    expect(client.attachment.profileId).toBe('/home/u/.hermes');
  });

  it('fails closed when the server negotiates a different subprotocol', async () => {
    const g = await gateway({ selectProtocol: () => 'something-else' });
    await expect(connect(g)).rejects.toMatchObject({ name: 'HermesGatewayConnectError', kind: 'subprotocol_mismatch' });
  });

  it('fails closed when the server selects no subprotocol at all', async () => {
    const g = await gateway({ selectProtocol: () => false });
    await expect(connect(g)).rejects.toBeInstanceOf(HermesGatewayConnectError);
  });

  it('tolerates a gateway that does not serve client.capabilities on the canonical socket', async () => {
    const g = await gateway({
      methods: { 'client.capabilities': () => { throw new FakeGatewayRpcFailure(-32601, 'unknown_method'); } },
    });
    await expect(connect(g)).resolves.toBeTruthy();
  });

  it.each([
    ['runtime protocol is not 1', { runtimeProtocol: 2 }, 'incompatible_runtime'],
    ['durable admission is missing', { capabilities: ['event-replay-v1'] }, 'missing_capability'],
    ['event replay is missing', { capabilities: ['durable-admission-v1'] }, 'missing_capability'],
  ] as const)('requires a compatible runtime (%s)', async (_label, override, kind) => {
    const g = await gateway({
      runtime: {
        instance_id: 'i', profile_id: '/p', authority_epoch: 1,
        capabilities: 'capabilities' in override ? override.capabilities : ['durable-admission-v1', 'event-replay-v1'],
        session_create: { sources: ['tui'], parameters: [] },
      },
    });
    const attachment = g.attachment(override);
    await expect(connectHermesGatewayClient({ attach: async () => attachment })).rejects.toMatchObject({ kind });
  });

  it('attaches again for every connect because tickets are single-use', async () => {
    const g = await gateway();
    let attachCalls = 0;
    const attach = async () => { attachCalls += 1; return g.attachment(); };
    const first = await connectHermesGatewayClient({ attach });
    const second = await connectHermesGatewayClient({ attach });
    clients.push(first, second);
    expect(attachCalls).toBe(2);
    expect(g.tickets).toHaveLength(2);
    expect(new Set(g.tickets).size).toBe(2);
  });

  it('correlates concurrent requests by id and maps JSON-RPC errors', async () => {
    const g = await gateway({
      methods: {
        'a.slow': async () => { await new Promise((r) => setTimeout(r, 30)); return { which: 'slow' }; },
        'a.fast': () => ({ which: 'fast' }),
        'a.fail': () => { throw new FakeGatewayRpcFailure(4001, 'invalid_params', { fields: ['x'] }); },
      },
    });
    const client = await connect(g);
    const [slow, fast] = await Promise.all([client.request('a.slow'), client.request('a.fast')]);
    expect(slow).toEqual({ which: 'slow' });
    expect(fast).toEqual({ which: 'fast' });
    const error = await client.request('a.fail').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermesGatewayRpcError);
    expect(error).toMatchObject({ code: 4001, message: 'invalid_params', data: { fields: ['x'] } });
  });

  it('times out an ordinary request but keeps lifecycle-owned requests (timeoutMs null) pending', async () => {
    const g = await gateway({ methods: { 'never.answers': () => new Promise(() => {}) } });
    const client = await connect(g, { requestTimeoutMs: 40 });
    await expect(client.request('never.answers')).rejects.toMatchObject({ name: 'HermesGatewayTimeoutError' });

    const pending = client.request('never.answers', {}, { timeoutMs: null });
    const outcome = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 120))]);
    expect(outcome).toBe('pending');
    await client.close();
    await expect(pending).rejects.toBeDefined();
  });

  it('supports caller cancellation of an in-flight request', async () => {
    const g = await gateway({ methods: { 'never.answers': () => new Promise(() => {}) } });
    const client = await connect(g);
    const controller = new AbortController();
    const pending = client.request('never.answers', {}, { timeoutMs: null, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('delivers session events with their replay stamps', async () => {
    const g = await gateway();
    const client = await connect(g);
    const seen: HermesGatewayEvent[] = [];
    const off = client.onEvent((e) => seen.push(e));
    g.emit('message.delta', 's1', { text: 'hi' }, { seq: 4, replay_epoch: 'e1', execution_generation: 2 });
    await new Promise((r) => setTimeout(r, 50));
    off();
    g.emit('message.delta', 's1', { text: 'ignored' }, { seq: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([{ type: 'message.delta', session_id: 's1', payload: { text: 'hi' }, seq: 4, replay_epoch: 'e1', execution_generation: 2 }]);
  });

  it('answers server-to-client requests with method-not-found so the agent fails fast', async () => {
    const g = await gateway();
    await connect(g);
    g.sendServerRequest('srq-1', 'sudo', { command: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(g.clientResponses).toContainEqual(expect.objectContaining({ id: 'srq-1', error: expect.objectContaining({ code: -32601 }) }));
  });

  it('rejects pending requests and notifies once when the socket drops', async () => {
    const g = await gateway({ methods: { 'never.answers': () => new Promise(() => {}) } });
    const client = await connect(g);
    const closes: Array<Error | null> = [];
    client.onClose((error) => closes.push(error));
    const pending = client.request('never.answers', {}, { timeoutMs: null });
    g.dropConnections();
    await expect(pending).rejects.toMatchObject({ name: 'HermesGatewayConnectionClosedError' });
    expect(closes).toHaveLength(1);
    expect(closes[0]).not.toBeNull();
    await expect(client.request('runtime.describe')).rejects.toMatchObject({ name: 'HermesGatewayConnectionClosedError' });
  });

  it('treats a silent socket as dropped once the heartbeat deadline passes', async () => {
    const g = await gateway();
    const client = await connect(g, { heartbeatIntervalMs: 20, heartbeatDeadlineMs: 80 });
    const closed = new Promise<Error | null>((resolve) => client.onClose(resolve));
    g.silence();
    const error = await closed;
    expect(error).toMatchObject({ name: 'HermesGatewayConnectionClosedError' });
    expect(error?.message).toMatch(/heartbeat/i);
  });

  it('keeps a healthy idle socket open across several heartbeat intervals', async () => {
    const g = await gateway();
    const client = await connect(g, { heartbeatIntervalMs: 20, heartbeatDeadlineMs: 80 });
    let closed = false;
    client.onClose(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 250));
    expect(closed).toBe(false);
  });
});
