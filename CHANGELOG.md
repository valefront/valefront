# Changelog

## [Unreleased]

### Added

- `POST /v1/responses`, so OpenAI Codex CLI works with the gateway.
- `POST /v1/embeddings`, `POST /v1/audio/transcriptions` and `POST /v1/audio/speech`.
- Cloudflare Workers AI and Deepgram providers.

### Fixed

- `GET /mcp` answers `405` instead of `404`, as the MCP spec asks.
- Images, audio and files in message content reach the upstream model instead of being flattened to text; requests with images skip providers that can't read them.

## [1.3.3] - 2026-06-25

### Added

- LiteLLM payload audit logging, without prompt contents.
- The LiteLLM Azure launcher writes model context metadata, disables its cache and enables pre-call checks.

### Fixed

- The LiteLLM streaming parser buffers SSE lines across transport chunks.
- Stream usage is recorded when LiteLLM returns it.
- Cursor's flat tool definitions are normalized before reaching LiteLLM.

## [1.3.0] - 2026-06-24

### Added

- Azure OpenAI and OpenAI providers.
- Fixed-model mode through `LEYLINE_ROUTER_ENABLED=false`.
- Apple Keychain persistence for saved API keys.
- LiteLLM provider and `npm run litellm:azure`.

### Changed

- Prompt compression uses the Python `headroom-ai` package.

### Fixed

- Ollama is opt-in and rejects cloud model names.

## [1.2.0] - 2026-06-17

### Added

- Optional prompt compression.

## [1.1.0] - 2026-06-17

### Added

- Semantic router: `Classifier`, `ModelRegistry`, the tier policy and `POST /v1/route`.
- LM Studio provider.
- Dockerfile and Docker Compose file.

### Changed

- License is MIT.
