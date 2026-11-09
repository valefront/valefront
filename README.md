# Valefront

<img src="valefront-logo.png" alt="Valefront logo" width="120"/>

An open-source LLM gateway you run yourself. Valefront puts cloud providers (OpenAI, Anthropic, Gemini, Azure OpenAI, OpenRouter, Hugging Face and others) and local models (Ollama, LM Studio) behind one OpenAI-compatible API, with provider failover, optional rate limits and semantic routing.

## Quick start

Needs Node.js 22 or later.

```bash
git clone https://github.com/valefront/valefront.git
cd valefront
npm ci
cp .env.example .env     # then set at least one provider key, such as OPENAI_API_KEY
npm run build
npm start
```

The server listens on `http://127.0.0.1:3000`. Send it a request:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer leyline" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'
```

`leyline` is the default client key. Set `LEYLINE_CLIENT_API_KEY` to your own before exposing the server.

## Documentation

- [Configuration](docs/configuration.md): the settings, by topic
- [Routing](docs/routing.md): failover, semantic routing, fixed-model mode
- [API and MCP](docs/api.md): endpoints and client setup
- [Provider keys](docs/provider-keys.md): where keys can live
- [Remote access](docs/remote-access.md): reaching the server from elsewhere
- [Library use](docs/library.md): using the router from TypeScript
- [Cursor with Azure OpenAI](docs/cursor-azure.md): the LiteLLM adapter
- [Changelog](CHANGELOG.md)

## License

MIT
