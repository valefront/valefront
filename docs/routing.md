# Routing

## Failover

A request names a model, or `auto`. Valefront tries the providers that serve it, in registration order, and moves to the next when one fails or is rate-limited. A stream that fails partway is continued on the next provider where possible.

To send one request to a particular provider, add the header `x-leyline-force-provider: <name>`.

## Semantic routing

Set `LEYLINE_ROUTER_MODEL` to a small classifier model, such as `arch-router-1.5b.gguf`, served at `LEYLINE_OPENAI_BASE_URL`. It labels each request:

```text
COMPLEXITY: simple | medium | complex
DOMAIN: chat | coding | planning | workflow | memory | extraction
REASONING: true | false
```

A fixed policy then picks a tier:

| Classification | Tier |
| --- | --- |
| memory or extraction | `2b` |
| workflow or planning | `12b` |
| coding, medium or complex | `12b` |
| reasoning required | `12b` |
| otherwise simple | `2b` |
| otherwise medium | `4b` |
| otherwise complex | `12b` |
| none, or a classifier error | `4b` |

`LEYLINE_MODEL_2B`, `LEYLINE_MODEL_4B` and `LEYLINE_MODEL_12B` say which model serves each tier. `POST /v1/route` returns this decision without calling a model.

## One fixed model

```bash
LEYLINE_ROUTER_ENABLED=false
LEYLINE_FIXED_PROVIDER=OpenAI
LEYLINE_FIXED_MODEL=gpt-5.5
```

Every chat request then goes to that model, whatever it names, and `/v1/route` returns the fixed decision.
