# Configuration

Settings are environment variables, read from the process or from `.env`.

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `LEYLINE_HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` in a container |
| `LEYLINE_CLIENT_API_KEY` | `leyline`, or random when the tunnel is on | Bearer token clients must send |
| `LEYLINE_CLIENT_AUTH_ENABLED` | `true` | `false` turns client auth off |
| `LEYLINE_BODY_LIMIT` | `100mb` | Largest JSON body |
| `LEYLINE_SESSION_SECRET` | per process | Signs `/mcp` session ids, so they survive a restart |
| `LEYLINE_TUNNEL_ENABLED` | `true` | Publish a public URL through Janus ([remote access](remote-access.md)); `.env.example` turns it off |

## Providers

A provider is used once it has a key (or, for local ones, a URL).

| Provider | Key | Other settings |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_DEFAULT_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_DEFAULT_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_DEFAULT_MODEL` |
| Hugging Face | `HF_API_KEY` | `HF_DEFAULT_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_DEFAULT_MODEL` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_DEFAULT_MODEL`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`; legacy `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| BytePlus ModelArk | `BYTEPLUS_ARK_API_KEY` | `BYTEPLUS_ARK_BASE_URL`, `BYTEPLUS_ARK_DEFAULT_MODEL` |
| BytePlus Vision (talking avatars) | `BYTEPLUS_VISION_ACCESS_KEY_ID`, `BYTEPLUS_VISION_SECRET_ACCESS_KEY` | |
| WaveSpeed (images, video) | `WAVESPEED_API_KEY` | `WAVESPEED_BASE_URL` |
| Deepgram (speech to text) | `DEEPGRAM_API_KEY` | `DEEPGRAM_BASE_URL` |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID` |
| Any OpenAI-compatible gateway | `LLM_API_KEY` | `LLM_API_BASE_URL`, `LLM_API_DEFAULT_MODEL` |
| LiteLLM proxy | `LITELLM_API_KEY` | `LITELLM_ENABLED`, `LITELLM_BASE_URL`, `LITELLM_MODEL` |
| LM Studio | none | `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL` |
| Ollama | none | `OLLAMA_ENABLED=true`, `OLLAMA_BASE_URL`, `OLLAMA_DEFAULT_MODEL` |

## Routing

See [routing](routing.md) for how these fit together.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEYLINE_ROUTER_MODEL` | none | Classifier model; setting it turns on semantic routing |
| `LEYLINE_OPENAI_BASE_URL` | `http://localhost:1234/v1` | Where the classifier model is served |
| `LEYLINE_ROUTER_MAX_TOKENS` | `64` | Classifier output limit |
| `LEYLINE_ROUTER_TEMPERATURE` | `0` | Classifier temperature |
| `LEYLINE_MODEL_2B`, `LEYLINE_MODEL_4B`, `LEYLINE_MODEL_12B` | none | The model behind each tier |
| `LEYLINE_ROUTER_ENABLED` | `true` | `false` sends every request to one fixed model |
| `LEYLINE_FIXED_PROVIDER`, `LEYLINE_FIXED_MODEL` | none | That provider and model |
| `LEYLINE_ENABLED_MODELS` | all | JSON `{"Provider": ["model", ...]}` limiting what `auto` may pick |
| `LEYLINE_AUTO_VISION_MODEL` | `gemini-2.5-flash-lite` | Preferred model for `auto` requests with images or audio |
| `LEYLINE_CUSTOM_VARIANTS` | built-in list | JSON array replacing the model registry |

## Rate limits

Off unless `LEYLINE_QUOTAS_ENABLED=true`. Each is per provider, as `<PROVIDER>_QUOTA_RPM` and `<PROVIDER>_QUOTA_RPD`.

| Provider prefix | RPM | RPD |
| --- | --- | --- |
| `GEMINI` | 10 | 1000 |
| `HF` | 100 | 1000 |
| `OPENAI` | 60 | 1000 |
| `OPENROUTER` | 20 | 200 |
| `AZURE_OPENAI` | 60 | 1000 |

## Prompt compression

Off by default. It needs `pip install headroom-ai`.

| Variable | Meaning |
| --- | --- |
| `LEYLINE_COMPRESSION_ENABLED` | `true` compresses messages before they reach a provider |
| `LEYLINE_COMPRESSION_MODEL` | Model hint for the compressor |
| `LEYLINE_COMPRESSION_TOKEN_BUDGET` | Compress to fit this many tokens |
