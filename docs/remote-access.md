# Remote access

The server binds to `127.0.0.1`. To reach it from elsewhere, either bind it wider behind your own reverse proxy (`LEYLINE_HOST=0.0.0.0`) or use a Janus tunnel. Set your own `LEYLINE_CLIENT_API_KEY` first in both cases.

Requests that arrive through a proxy can reach only the API endpoints and health checks. The local management API stays localhost-only.

## Janus tunnel

With `LEYLINE_TUNNEL_ENABLED` on, Valefront starts or connects to Janus, which supervises the tunnel and publishes a public URL. Valefront registers a stable `namespace/alias` identity and logs the URL on startup. If `LEYLINE_CLIENT_API_KEY` is unset, it generates a new random key for that process and logs that too.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEYLINE_JANUS_COMMAND` | `janus` | The executable |
| `LEYLINE_JANUS_CONFIG` | none | YAML config passed to `janus run` |
| `LEYLINE_JANUS_BASE_URL` | `http://127.0.0.1:8088` | Janus's local API |
| `LEYLINE_JANUS_SERVICE_ID` | `leyline` | Registered service id |
| `LEYLINE_JANUS_NAMESPACE`, `LEYLINE_JANUS_ALIAS` | `leyline`, `api` | Stable identity |
| `LEYLINE_JANUS_PUBLIC_URL` | none | A public URL to register |
| `LEYLINE_JANUS_AUTOSTART` | `true` | Start Janus if its API is down |
| `LEYLINE_JANUS_API_KEY`, `LEYLINE_JANUS_PAIRING_CODE` | none | Credentials for an authenticated Janus |
| `LEYLINE_TUNNEL_TIMEOUT_MS` | `45000` | How long to wait for the public URL |

If the tunnel fails, the server keeps running locally.
