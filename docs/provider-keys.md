# Provider keys

A provider's key is looked up in this order:

1. The environment or `.env`.
2. An Arcana reference, if one is configured.
3. Apple Keychain, on macOS.

## Arcana references

Arcana references resolve through the local `arcana` command and are read-only.

```bash
LEYLINE_ARCANA_OPENAI_REF=arcana://openai/api-key
```

The per-provider variables are `LEYLINE_ARCANA_<PROVIDER>_REF`, for example `LEYLINE_ARCANA_GEMINI_REF`, `LEYLINE_ARCANA_HF_REF`, `LEYLINE_ARCANA_OPENROUTER_REF`, `LEYLINE_ARCANA_AZURE_OPENAI_REF`. `LEYLINE_ARCANA_SECRET_REFS` takes a JSON map of account to reference instead, and `LEYLINE_ARCANA_COMMAND` and `LEYLINE_ARCANA_RUNNER` change how Arcana is run.

## Keychain

`LEYLINE_KEYCHAIN_ENABLED=false` turns Keychain off. `LEYLINE_KEYCHAIN_SERVICE` names the Keychain service.

## Local management API

These answer only on localhost and refuse requests that came through a proxy. Raw keys are never returned.

| Endpoint | Purpose |
| --- | --- |
| `GET /dashboard/api-keys` | Each provider's key status |
| `POST /dashboard/api-keys` | Save a key: `{provider, apiKey, persistence}`, where `persistence` is `keychain` or `memory` |
| `DELETE /dashboard/api-keys/:provider` | Clear a key |
| `GET`, `POST /dashboard/routing` | Read or set fixed-model mode and the model pool |
| `GET /dashboard/stats` | Provider status and recent requests |
