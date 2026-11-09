import { webcrypto } from 'node:crypto';
import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { config } from '../src/config';
import { MCP_SESSION_TTL_MS } from '../src/mcp/http';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

process.env.LEYLINE_SESSION_SECRET = 'test-mcp-session-secret';

function createApp() {
  const quotaManager = new QuotaManager();
  return createServer(new Router(quotaManager), quotaManager);
}

/** The app as a second server process runs it: every module loaded afresh (no memory shared with createApp's). */
function createAppInAnotherIsolate() {
  let app: ReturnType<typeof createApp> | undefined;
  jest.isolateModules(() => {
    // The same deployment: the same client key (config would otherwise generate a new one for this process).
    require('../src/config').config.clientApiKey = config.clientApiKey;
    const { createServer: create } = require('../src/server');
    const { Router: R } = require('../src/core/router');
    const { QuotaManager: Q } = require('../src/core/quota-manager');
    const quotaManager = new Q();
    app = create(new R(quotaManager), quotaManager);
  });
  return app!;
}

const initialize = (app: ReturnType<typeof createApp>, auth: Record<string, string> = LEYLINE_CLIENT_AUTH_HEADER) =>
  request(app).post('/mcp').set(auth).send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
const toolsList = (app: ReturnType<typeof createApp>, session: string, auth: Record<string, string> = LEYLINE_CLIENT_AUTH_HEADER) =>
  request(app).post('/mcp').set(auth).set('Mcp-Session-Id', session).send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

describe('MCP Streamable HTTP endpoint', () => {
  it('requires the Leyline client API key', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(response.status).toBe(401);
  });

  it('initializes an authenticated session and lists Leyline tools', async () => {
    const app = createApp();
    const initialize = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });

    expect(initialize.status).toBe(200);
    expect(initialize.headers['mcp-session-id']).toBeDefined();
    expect(initialize.body.result.serverInfo.name).toBe('leyline');

    const tools = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('Mcp-Session-Id', initialize.headers['mcp-session-id'])
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(tools.status).toBe(200);
    expect(tools.body.result.tools[0].name).toBe('leyline_chat');
  });

  it('rejects requests without a valid initialized session', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(response.status).toBe(400);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps a session on another isolate (nothing kept in memory)', async () => {
    const init = await initialize(createApp());
    const session = init.headers['mcp-session-id'];
    expect(init.status).toBe(200);

    const other = createAppInAnotherIsolate();
    const notified = await request(other).post('/mcp').set(LEYLINE_CLIENT_AUTH_HEADER).set('Mcp-Session-Id', session)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notified.status).toBe(202);
    const tools = await toolsList(other, session);
    expect(tools.status).toBe(200);
    expect(tools.body.result.tools[0].name).toBe('leyline_chat');
  });

  it('refuses a tampered session id', async () => {
    const app = createApp();
    const session: string = (await initialize(app)).headers['mcp-session-id'];
    const [issuedAt, nonce, mac] = session.split('.');
    const flip = (v: string) => (v[0] === 'A' ? 'B' : 'A') + v.slice(1);
    for (const tampered of [`${issuedAt}.${nonce}.${flip(mac)}`, `${issuedAt}.${flip(nonce)}.${mac}`, `${(parseInt(issuedAt, 36) + 1).toString(36)}.${nonce}.${mac}`, `${issuedAt}.${nonce}`, 'not-a-session']) {
      const res = await toolsList(app, tampered);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A valid Mcp-Session-Id is required after initialize.');
    }
  });

  it('refuses an expired session id (24 hours)', async () => {
    const app = createApp();
    const start = Date.now();
    const session = (await initialize(app)).headers['mcp-session-id'];
    jest.spyOn(Date, 'now').mockReturnValue(start + MCP_SESSION_TTL_MS - 60_000);
    expect((await toolsList(app, session)).status).toBe(200);
    jest.spyOn(Date, 'now').mockReturnValue(start + MCP_SESSION_TTL_MS + 60_000);
    expect((await toolsList(app, session)).status).toBe(400);
  });

  it('refuses a session id signed with another secret', async () => {
    const app = createApp();
    const session = (await initialize(app)).headers['mcp-session-id'];
    process.env.LEYLINE_SESSION_SECRET = 'another-deployment';
    try {
      expect((await toolsList(app, session)).status).toBe(400);
    } finally {
      process.env.LEYLINE_SESSION_SECRET = 'test-mcp-session-secret';
    }
  });

  it('allows an authenticated client to terminate its session', async () => {
    const app = createApp();
    const initialize = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const sessionId = initialize.headers['mcp-session-id'];

    const terminated = await request(app)
      .delete('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('Mcp-Session-Id', sessionId);

    expect(terminated.status).toBe(204);
    // On another isolate too: no server state is needed to end a session.
    const elsewhere = await request(createAppInAnotherIsolate()).delete('/mcp').set(LEYLINE_CLIENT_AUTH_HEADER).set('Mcp-Session-Id', sessionId);
    expect(elsewhere.status).toBe(204);
    const unknown = await request(app).delete('/mcp').set(LEYLINE_CLIENT_AUTH_HEADER).set('Mcp-Session-Id', 'not-a-session');
    expect(unknown.status).toBe(404);
  });

  it('keeps the public health check available without exposing MCP', async () => {
    const response = await request(createApp())
      .get('/healthz')
      .set('cf-connecting-ip', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'leyline' });
  });
});

describe('leyline_chat over /mcp', () => {
  it('initialize, tools/list and tools/call work end to end', async () => {
    const quotaManager = new QuotaManager();
    const router = new Router(quotaManager);
    router.addProvider({
      name: 'Stub',
      defaultModel: 'stub-model',
      isAvailable: async () => true,
      getModels: async () => [{ id: 'stub-model' }],
      complete: async (req: { model: string }) => ({ id: 'r', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }),
      completeStream: async function* () { throw new Error('not used'); },
    } as never);
    const app = createServer(router, quotaManager);
    const session = (await initialize(app)).headers['mcp-session-id'];
    expect((await toolsList(app, session)).body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['leyline_chat']);
    const called = await request(app).post('/mcp').set(LEYLINE_CLIENT_AUTH_HEADER).set('Mcp-Session-Id', session).send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'leyline_chat', arguments: { model: 'stub-model', messages: [{ role: 'user', content: 'ping' }] } },
    });
    expect(called.status).toBe(200);
    expect(JSON.stringify(called.body.result)).toContain('pong');
  });
});
