# API and MCP

Every endpoint except the health checks needs `Authorization: Bearer <LEYLINE_CLIENT_API_KEY>`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat format, streaming and tools included |
| `POST /v1/responses` | OpenAI Responses format. Stateless: send the whole conversation in `input` |
| `POST /v1/route` | Routing decision for `{user_message, chat_history?}`, without calling a model |
| `POST /v1/embeddings` | `{model, input, dimensions?, encoding_format?}` |
| `POST /v1/audio/transcriptions` | Multipart `file`, `model`, and optional `language`, `prompt`, `response_format`, `temperature` |
| `POST /v1/audio/speech` | `{model, input, voice?, response_format?, speed?, instructions?}`, answers with audio |
| `POST /v1/images/generations` | `{model, prompt, n?, size?, image?, seed?, response_format?}` |
| `POST /v1/videos`, `GET /v1/videos/:id` | Start a video and poll it. Jobs last as long as the process |
| `POST /mcp`, `DELETE /mcp` | MCP Streamable HTTP |
| `GET /healthz`, `GET /readyz` | Health checks, no key needed |

`model: "auto"` takes the routed or default model.

## Clients

Point any OpenAI-compatible client at the server:

```typescript
const client = new OpenAI({ baseURL: 'http://127.0.0.1:3000/v1', apiKey: 'leyline' });
```

Clients send the Valefront client key, never a provider key. Provider keys stay on the server.

## MCP

Initialize a session, keep the `Mcp-Session-Id` response header, and send it on later requests. Sessions last 24 hours; set `LEYLINE_SESSION_SECRET` so they survive a restart.

```bash
curl -i http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer leyline" -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}'
```

The one tool, `leyline_chat`, takes a chat completions request (`model` and `messages` are required) and answers in one piece:

```json
{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
 "params": {"name": "leyline_chat", "arguments": {"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}}}
```
