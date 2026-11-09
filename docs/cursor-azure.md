# Cursor with Azure OpenAI

Cursor Agent sends request shapes that Azure's chat endpoint rejects. A local LiteLLM proxy adapts them. LiteLLM must be installed.

In `.env`:

```bash
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_BASE_URL=https://your-resource.services.ai.azure.com/openai/v1
AZURE_OPENAI_DEFAULT_MODEL=gpt-5.5
LITELLM_ENABLED=true
LITELLM_BASE_URL=http://127.0.0.1:4000/v1
LITELLM_MODEL=gpt-5.5
LITELLM_API_KEY=not-needed
LEYLINE_ROUTER_ENABLED=false
LEYLINE_FIXED_PROVIDER=LiteLLM
LEYLINE_FIXED_MODEL=gpt-5.5
```

Start the proxy in one terminal and the server in another:

```bash
npm run litellm:azure
npm start
```

| Variable | Meaning |
| --- | --- |
| `LITELLM_PORT` | Proxy port, default `4000` |
| `LITELLM_BASE_MODEL` | Azure base model, for context-window accounting |
| `LITELLM_MAX_INPUT_TOKENS`, `LITELLM_MAX_OUTPUT_TOKENS` | Context limits |
| `LITELLM_TOKEN_CHAR_RATIO` | Characters per token, for the preflight estimate |
| `LEYLINE_LITELLM_PREFLIGHT_ENABLED` | `true` turns on a size check before sending |
| `LITELLM_PAYLOAD_AUDIT` | `true` logs metadata about each payload, never its content |
