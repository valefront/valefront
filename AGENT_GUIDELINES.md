# Agent guidelines

Run `npm test` and `npm run build` before finishing a change.

## Providers and keys

- Azure supports `AZURE_OPENAI_BASE_URL` (OpenAI-compatible v1 API) and the legacy `AZURE_OPENAI_ENDPOINT` plus deployment URLs. Keep Azure deployment names separate from OpenAI model ids in registry decisions.
- `.env` keys take precedence over Arcana, and Arcana over Keychain. Arcana is read-only.
- Never return raw provider keys from any API.
- `security find-generic-password` exits nonzero for a missing item: treat that as an unconfigured key, not an unavailable Keychain.
- Ollama is opt-in. `canHandle` rejects registry cloud models and accepts only installed local tags.

## Routing and requests

- Fixed-model mode is `LEYLINE_ROUTER_ENABLED=false` with `LEYLINE_FIXED_MODEL`. `LEYLINE_FIXED_PROVIDER` is optional when the registry can infer it, and required for Azure when a deployment name matches an OpenAI model id.
- Normalize chat payloads at the server boundary (`normalizeCompletionRequest`). `ChatMessage.content` is `string | ContentPart[] | null`.
- The router runs `ensureMessageArray` before every provider call and rejects empty message arrays.
- Provider quotas are off by default (`LEYLINE_QUOTAS_ENABLED`).
- `ProviderRateLimiter` queues per provider. Rejected acquires must not poison later work, and delay logging must not reject traffic.

## LiteLLM and Cursor

- LiteLLM is the Azure adapter for Cursor Agent's request shapes. Prefer it to adding more Azure shims.
- Parse LiteLLM streams as buffered SSE, not per transport chunk.
- Cursor sends flat tools (`tools[i].name`); normalize them before forwarding.

## Server surface

- The `/dashboard` management API is localhost-only and refuses requests with proxy headers.
- Requests through a proxy reach only the allowlist in `src/server.ts`.
- Janus integration uses the `namespace/alias` contract, not `/api/services/{id}`.
