import request from 'supertest';
import { chatToolName, responsesToChat, ResponsesRequestError } from '../src/core/responses';
import type { CompletionRequest, StreamChunk } from '../src/core/types';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

function gateway(chunks: StreamChunk[] = []) {
  const seen: CompletionRequest[] = [];
  const quotaManager = new QuotaManager();
  const router = new Router(quotaManager);
  router.addProvider({
    name: 'Stub',
    defaultModel: 'stub-model',
    isAvailable: async () => true,
    getModels: async () => [{ id: 'stub-model' }],
    complete: async (req: CompletionRequest) => {
      seen.push(req);
      return { id: 'r', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    },
    completeStream: async function* (req: CompletionRequest) {
      seen.push(req);
      for (const c of chunks) yield c;
    },
  } as never);
  return { app: createServer(router, quotaManager), seen };
}

const post = (app: ReturnType<typeof createServer>, body: Record<string, unknown>) =>
  request(app).post('/v1/responses').set(LEYLINE_CLIENT_AUTH_HEADER).send(body);

describe('POST /v1/responses', () => {
  it('answers a request in the Responses format', async () => {
    const { app, seen } = gateway();
    const r = await post(app, { model: 'stub-model', input: 'Hello' });
    expect(r.status).toBe(200);
    expect(r.body.object).toBe('response');
    expect(r.body.output_text ?? JSON.stringify(r.body.output)).toContain('Hi there');
    expect(seen[0].messages[seen[0].messages.length - 1]).toMatchObject({ role: 'user' });
  });

  it('streams Responses events', async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      ({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [{ index: 0, delta, finish_reason: finish }] }) as unknown as StreamChunk;
    const { app } = gateway([chunk({ role: 'assistant', content: 'Hi' }), chunk({}, 'stop')]);
    const r = await post(app, { model: 'stub-model', input: 'Hello', stream: true });
    expect(r.status).toBe(200);
    expect(r.text).toContain('response.output_text.delta');
    expect(r.text).toContain('response.completed');
  });

  it('refuses previous_response_id and an empty input', async () => {
    const { app, seen } = gateway();
    expect((await post(app, { model: 'stub-model', input: 'x', previous_response_id: 'resp_1' })).status).toBe(400);
    expect((await post(app, { model: 'stub-model', input: [] })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('responsesToChat', () => {
  it('custom (freeform) tools become one-string-argument functions, and their calls round-trip', () => {
    const { request: chat, tools } = responsesToChat({
      model: 'm',
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } }],
      input: [
        { type: 'custom_tool_call', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_p', output: 'Done' },
      ],
    });
    expect(chat.tools).toEqual([{ type: 'function', function: { name: 'apply_patch', description: 'Patch files', parameters: expect.objectContaining({ required: ['input'] }) } }]);
    expect(JSON.stringify(chat.tools)).toContain('start: \\"x\\"');
    expect(tools.get('apply_patch')).toEqual({ kind: 'custom', name: 'apply_patch' });
    expect(chat.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_p', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] },
      { role: 'tool', tool_call_id: 'call_p', content: 'Done' },
    ]);
  });

  it('assistant text and its calls are one message; images a tool returned follow the tool messages; orphan outputs stay as context', () => {
    const { request: chat } = responsesToChat({
      model: 'm',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thinking' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        { type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,BBB' }] },
        { type: 'function_call_output', call_id: 'missing', output: 'late' },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '' },
      { role: 'user', content: 'Output of tool call missing:\nlate' },
      { role: 'user', content: [{ type: 'text', text: 'The images the tool calls above returned:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }] },
    ]);
  });

  it('maps text.format, reasoning effort and sampling settings; refuses conversation and background', () => {
    const { request: chat } = responsesToChat({ model: 'm', input: 'x', temperature: 0.2, top_p: 0.9, reasoning: { effort: 'high' }, text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } } });
    expect(chat).toMatchObject({ temperature: 0.2, top_p: 0.9, reasoning_effort: 'high', response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } } });
    expect(() => responsesToChat({ model: 'm', input: 'x', conversation: 'conv_1' })).toThrow(ResponsesRequestError);
    expect(() => responsesToChat({ model: 'm', input: 'x', background: true })).toThrow(ResponsesRequestError);
    expect(() => responsesToChat({ input: 'x' })).toThrow(/model is required/);
  });

  it('long or unusual tool names get stable, valid chat names', () => {
    const name = chatToolName('a'.repeat(40), 'mcp.server-with.dots');
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(chatToolName('a'.repeat(40), 'mcp.server-with.dots')).toBe(name);
    expect(chatToolName('read', 'fs')).toBe('fs__read');
  });
});
