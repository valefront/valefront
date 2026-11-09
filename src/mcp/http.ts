import type { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Sessions are stateless: each request may land on another server process, so nothing is kept in memory. The
 * Mcp-Session-Id is `<issued-at>.<nonce>.<mac>`, the MAC an HMAC-SHA256 (under a key derived from
 * LEYLINE_SESSION_SECRET) over the caller's credential, the issued-at time and the nonce. A request's session
 * is valid when the MAC matches for the key making that request and it was issued less than MCP_SESSION_TTL_MS ago.
 * This is only MCP protocol compliance: auth happens on every request.
 */
export const MCP_SESSION_TTL_MS = 24 * 3600_000;
const MCP_SESSION_MAX_SKEW_MS = 5 * 60_000;
let fallbackSecret: string | undefined;

function sessionKey(): Buffer {
  let secret = process.env.LEYLINE_SESSION_SECRET;
  if (!secret) {
    // Local/desktop without the secret: one process serves every request, so a per-process secret is enough.
    if (!fallbackSecret) {
      fallbackSecret = randomBytes(32).toString('base64url');
      console.warn('[Leyline] LEYLINE_SESSION_SECRET is unset: MCP sessions last only as long as this process');
    }
    secret = fallbackSecret;
  }
  return createHmac('sha256', secret).update('valefront/mcp-session/v1').digest();
}

/** Who a session belongs to: the credential presented, else no one. */
function sessionOwner(req: Request): string {
  const auth = req.headers.authorization;
  const x = req.headers['x-api-key'];
  const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : typeof x === 'string' ? x.trim() : '';
  return presented ? `cred:${createHash('sha256').update(presented).digest('base64url')}` : 'none';
}

function sessionMac(owner: string, issuedAt: string, nonce: string): string {
  return createHmac('sha256', sessionKey()).update(`v1|${owner}|${issuedAt}|${nonce}`).digest('base64url');
}

/** A new session id for the key making this request. */
export function issueMcpSession(req: Request): string {
  const issuedAt = Date.now().toString(36);
  const nonce = randomBytes(16).toString('base64url');
  return `${issuedAt}.${nonce}.${sessionMac(sessionOwner(req), issuedAt, nonce)}`;
}

function response(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorResponse(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** The chat tool. Its calls are /v1/chat/completions requests (see mcpChatCall); this module never routes one. */
export const MCP_CHAT_TOOL = 'leyline_chat';

/** Why the chat tool's arguments aren't a chat request (null: they are one). */
function chatArgumentsProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'arguments must be an object';
  const input = value as { model?: unknown; messages?: unknown };
  if (typeof input.model !== 'string' || !Array.isArray(input.messages)) return 'arguments.model and arguments.messages are required';
  return null;
}

/**
 * A `tools/call` of the chat tool with valid arguments: its JSON-RPC id and the /v1/chat/completions body it is.
 * The server runs that body through the chat handler (src/server.ts). The tool answers in one piece: `stream` is always off (an MCP tool
 * result can't stream), so it is dropped. Anything else (other methods, bad arguments): null, and createMcpHttpHandler answers it.
 */
export function mcpChatCall(body: unknown): { id: JsonRpcRequest['id']; request: Record<string, unknown> } | null {
  const message = body as JsonRpcRequest | null;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || message.method !== 'tools/call') return null;
  const params = message.params || {};
  if (params.name !== MCP_CHAT_TOOL || chatArgumentsProblem(params.arguments)) return null;
  const { stream: _stream, stream_options: _options, ...request } = params.arguments as Record<string, unknown>;
  return { id: message.id ?? null, request };
}

/** The request's Mcp-Session-Id was issued by initialize to the same key, and hasn't expired. */
export function hasMcpSession(req: Request): boolean {
  const parts = (req.header('Mcp-Session-Id') || '').split('.');
  if (parts.length !== 3 || !parts.every(Boolean)) return false;
  const [issuedAt, nonce, mac] = parts;
  const issued = parseInt(issuedAt, 36);
  const age = Date.now() - issued;
  if (!Number.isFinite(issued) || age > MCP_SESSION_TTL_MS || age < -MCP_SESSION_MAX_SKEW_MS) return false;
  const expected = Buffer.from(sessionMac(sessionOwner(req), issuedAt, nonce));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const MCP_SESSION_REQUIRED = { error: 'A valid Mcp-Session-Id is required after initialize.' };

/**
 * Answer the chat completions handler's JSON as the chat tool's result, for the call with this id. A refusal before
 * anything was routed keeps chat's HTTP status and body; a provider
 * failure (res.locals.providerFailed) is a tool error, as before; an answer is the tool's result, with the routing
 * strategy's choice (chat's X-Valefront-Route header, also sent here) in `_meta`.
 */
export function answerAsChatTool(res: Response, id: JsonRpcRequest['id']): void {
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 400 && !res.locals.providerFailed) return json(body);
    if (res.statusCode >= 400) {
      res.status(200);
      return json(response(id, {
        content: [{ type: 'text', text: body?.error?.message || 'Valefront request failed' }],
        structuredContent: body,
        isError: true,
      }));
    }
    const route = res.getHeader('X-Valefront-Route');
    return json(response(id, {
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
      isError: false,
      ...(route ? { _meta: { 'valefront/route': String(route) } } : {}),
    }));
  }) as Response['json'];
}

function handleMessage(message: JsonRpcRequest): JsonRpcResponse | null {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id, -32600, 'Invalid JSON-RPC request');
  }

  if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) {
    return null;
  }

  if (message.method === 'initialize') {
    return response(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'leyline', version: '1.3.3' },
    });
  }

  if (message.method === 'ping') return response(message.id, {});

  if (message.method === 'tools/list') {
    return response(message.id, {
      tools: [{
        name: MCP_CHAT_TOOL,
        description: 'Route a chat completion through Valefront, exactly like POST /v1/chat/completions.',
        inputSchema: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: { type: 'string' },
            messages: { type: 'array', items: { type: 'object' } },
          },
        },
      }],
    });
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    if (params.name !== MCP_CHAT_TOOL) {
      return errorResponse(message.id, -32602, 'Unknown tool');
    }
    // A valid chat tool call never gets here: the server runs it as a chat completion (mcpChatCall). Only arguments
    // that aren't a chat request do, and nothing is routed for them.
    return response(message.id, {
      content: [{ type: 'text', text: chatArgumentsProblem(params.arguments) ?? 'Valefront request failed' }],
      isError: true,
    });
  }

  return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
}

/** Everything /mcp answers except a chat tool call (initialize, ping, tools/list, DELETE, bad requests). */
export function createMcpHttpHandler() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'DELETE') {
      // Nothing to forget: a stateless session can't be revoked, it just stops being used (and expires).
      if (!hasMcpSession(req)) {
        res.status(404).json({ error: 'MCP session not found.' });
        return;
      }
      res.status(204).end();
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'MCP Streamable HTTP requires POST requests.' });
      return;
    }

    const message = req.body as JsonRpcRequest;
    if (message?.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', issueMcpSession(req));
    } else if (!hasMcpSession(req)) {
      res.status(400).json(MCP_SESSION_REQUIRED);
      return;
    }

    try {
      const result = handleMessage(message);
      if (result === null) {
        res.status(202).end();
        return;
      }
      res.type('application/json').json(result);
    } catch (error) {
      next(error);
    }
  };
}
