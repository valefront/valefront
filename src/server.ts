import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'http';
import cors from 'cors';
import { Router } from './core/router';
import { CompletionRequest, ClassifyRequest, Provider, ApiKeyConfigurableProvider, RuntimeConfigurableProvider, servesChat } from './core/types';
import { mountMediaRoutes } from './core/media-routes';
import { logger } from './core/logger';
import { QuotaManager } from './core/quota-manager';
import { config } from './config';
import { requireClientApiKey } from './core/client-auth';
import { chatCompletionErrorResponse, formatProviderError, hydrateAxiosError } from './core/api-errors';
import { normalizeCompletionRequest } from './core/normalize-request';
import { completionChars, usageOrEstimate, type TokenUsage } from './core/content';
import { ResponsesRequestError, ResponsesStream, chatToResponse, responsesToChat, sse, type ResponsesRequest } from './core/responses';
import { MCP_SESSION_REQUIRED, answerAsChatTool, createMcpHttpHandler, hasMcpSession, mcpChatCall } from './mcp/http';
import type { TunnelInfo } from './core/cloudflared-tunnel';
import { INSTANCE_FAMILIES } from './core/provider-instances';
import { generateInstanceId } from './core/instance-naming';
import {
  ApiKeyPersistenceMode,
  ApiKeySource,
  PersistedRoutingConfig,
  ROUTING_CONFIG_ACCOUNT,
  SecretStore,
  apiKeyAccount,
  createDefaultSecretStore,
  instanceManifestAccount,
  parseInstanceManifest,
  parseRoutingConfig,
  parseRuntimeConfig,
  runtimeConfigAccount,
  sanitizeEnabledModels,
  sanitizeModelPins,
  serializeInstanceManifest,
  serializeRoutingConfig,
  serializeRuntimeConfig,
} from './core/secret-store';

function isApiKeyConfigurableProvider(provider: Provider): provider is ApiKeyConfigurableProvider {
  const candidate = provider as Partial<ApiKeyConfigurableProvider>;
  return typeof candidate.setApiKey === 'function' && typeof candidate.hasApiKey === 'function';
}

function isRuntimeConfigurableProvider(provider: Provider): provider is RuntimeConfigurableProvider {
  const candidate = provider as Partial<RuntimeConfigurableProvider>;
  return typeof candidate.setRuntimeConfig === 'function' && typeof candidate.getRuntimeConfig === 'function';
}

export interface CreateServerOptions {
  apiKeyStore?: SecretStore;
  getTunnelInfo?: () => TunnelInfo;
  /** Bind address used by the standalone process. Defaults to loopback. */
  host?: string;
  /** Enable the public-proxy route allowlist. Defaults to true. */
  enforceExternalSurface?: boolean;
}

type ProviderKeyMetadata = {
  source: ApiKeySource;
};

function isApiKeyPersistenceMode(value: unknown): value is ApiKeyPersistenceMode {
  return value === 'keychain' || value === 'memory' || value === 'localStorage' || value === 'arcana';
}

function providerRuntimeReady(provider: Provider): boolean | undefined {
  if (!isRuntimeConfigurableProvider(provider)) return undefined;
  return Boolean(provider.getRuntimeConfig().baseUrlConfigured);
}

/** What a provider serves, for the dashboard (providers that don't say serve chat only). */
function providerCapabilities(provider: Provider): string[] {
  return provider.capabilities ?? ['chat'];
}

function dashboardRoutingStatus(router: Router) {
  const single = router.getSingleModel();
  return {
    singleModelEnabled: Boolean(single?.enabled),
    fixedProvider: single?.provider || null,
    fixedModel: single?.model || null,
    enabledModels: router.getEnabledModels() ?? {},
    modelPins: router.getModelPins(),
    modelIndex: router.getModelIndex(),
  };
}

function isLoopbackAddress(address?: string): boolean {
  return !address
    || address === '::1'
    || address === '127.0.0.1'
    || address === '::ffff:127.0.0.1';
}

function hasPublicProxyHeaders(req: Request): boolean {
  return Boolean(
    req.headers['cf-connecting-ip']
    || req.headers['cf-ray']
    || req.headers['cf-visitor']
    || req.headers['x-forwarded-for']
    || req.headers['x-real-ip'],
  );
}

function requireLocalDashboardAccess(req: Request, res: Response, next: NextFunction): void {
  const remoteAddress = req.socket.remoteAddress || req.ip;
  if (isLoopbackAddress(remoteAddress) && !hasPublicProxyHeaders(req)) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      message: 'Dashboard is only available from localhost.',
      type: 'access_denied',
      code: 'local_dashboard_only',
    },
  });
}

// What a request arriving through a public proxy or tunnel may reach.
const EXTERNAL_ROUTES = new Set([
  '/healthz', '/readyz', '/v1/chat/completions', '/v1/route', '/mcp', '/v1/responses',
  '/v1/embeddings', '/v1/audio/transcriptions', '/v1/audio/speech', '/v1/images/generations', '/v1/videos',
]);
const EXTERNAL_PREFIXES = ['/v1/videos/'];

function requireExternalSurfaceAllowlist(req: Request, res: Response, next: NextFunction): void {
  if (
    !hasPublicProxyHeaders(req)
    || EXTERNAL_ROUTES.has(req.path)
    || EXTERNAL_PREFIXES.some((p) => req.path === p || req.path.startsWith(p.endsWith('/') ? p : `${p}/`))
    || req.path === '/dashboard'
    || req.path.startsWith('/dashboard/')
  ) {
    next();
    return;
  }

  res.status(404).json({
    error: {
      message: 'Endpoint is not available through the external API surface.',
      type: 'not_found',
      code: 'external_endpoint_not_exposed',
    },
  });
}

export const createServer = (router: Router, quotaManager: QuotaManager, options: CreateServerOptions = {}) => {
  const app = express();
  const apiKeyStore = options.apiKeyStore || createDefaultSecretStore();
  const getTunnelInfo = options.getTunnelInfo;
  const keyMetadata = new Map<string, ProviderKeyMetadata>();

  const authMiddleware = requireClientApiKey;

  app.use(cors({ exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(express.json({ limit: config.bodyLimit }));

  if (options.enforceExternalSurface !== false) {
    app.use(requireExternalSurfaceAllowlist);
  }

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'leyline' });
  });

  app.get('/readyz', (_req, res) => {
    const providerCount = router.getProviders().length;
    res.status(providerCount > 0 ? 200 : 503).json({
      status: providerCount > 0 ? 'ready' : 'unavailable',
      service: 'leyline',
      providers: providerCount,
    });
  });

  // The management API is for this machine only.
  app.use('/dashboard', requireLocalDashboardAccess);

  // Simple in-memory cache for models
  const modelCache: Record<string, { models: any[], timestamp: number }> = {};
  const CACHE_TTL = 3600 * 1000; // 1 hour

  const applyRoutingConfig = (routing: PersistedRoutingConfig) => {
    if (routing.mode === 'pinned') {
      router.setSingleModel({
        enabled: true,
        provider: routing.pinnedProvider || null,
        model: routing.pinnedModel || null,
      });
    } else if (routing.mode === 'auto') {
      router.setSingleModel(undefined);
    }
    if (routing.enabledModels !== undefined) {
      const hasEntries = Object.keys(routing.enabledModels).length > 0;
      router.setEnabledModels(hasEntries ? routing.enabledModels : undefined);
    }
    if (routing.modelPins !== undefined) {
      const hasEntries = Object.keys(routing.modelPins).length > 0;
      router.setModelPins(hasEntries ? routing.modelPins : undefined);
    }
  };

  const persistRoutingConfig = async () => {
    const single = router.getSingleModel();
    await apiKeyStore.set(ROUTING_CONFIG_ACCOUNT, serializeRoutingConfig({
      mode: single?.enabled ? 'pinned' : 'auto',
      pinnedProvider: single?.provider || '',
      pinnedModel: single?.model || '',
      enabledModels: router.getEnabledModels(),
      modelPins: router.getModelPins(),
    }));
  };

  const initializeRouting = async () => {
    const persisted = await apiKeyStore.get(ROUTING_CONFIG_ACCOUNT);
    if (!persisted) return;
    const saved = parseRoutingConfig(persisted);
    if (saved) applyRoutingConfig(saved);
  };

  /** How long each startup step took (ms). */
  const readyStages: Record<string, number> = {};
  app.locals.readyStages = readyStages;
  const initializeApiKeys = async () => {
    const startedAt = Date.now();
    await initializeRouting();
    readyStages.routing = Date.now() - startedAt;
    const background: Promise<unknown>[] = [];
    await Promise.all(router.getProviders().map(async provider => {
      const providerAt = Date.now();
      const hydrate = async () => {
      if (isApiKeyConfigurableProvider(provider)) {
        if (provider.hasApiKey()) {
          keyMetadata.set(provider.name, { source: 'env' });
        } else {
          const persistedKey = await apiKeyStore.get(apiKeyAccount(provider.name));
          if (persistedKey) {
            provider.setApiKey(persistedKey);
            const source = apiKeyStore.getSource
              ? await apiKeyStore.getSource(apiKeyAccount(provider.name))
              : apiKeyStore.status().mode;
            keyMetadata.set(provider.name, { source });
          } else {
            keyMetadata.set(provider.name, { source: 'none' });
          }
        }
      }

      if (isRuntimeConfigurableProvider(provider)) {
        const persistedRuntime = await apiKeyStore.get(runtimeConfigAccount(provider.name));
        if (!persistedRuntime) return;

        const saved = parseRuntimeConfig(persistedRuntime);
        if (!saved) return;

        const current = provider.getRuntimeConfig();
        provider.setRuntimeConfig({
          baseUrl: current.baseUrlConfigured ? undefined : saved.baseUrl,
          model: saved.model,
        });
      }
      };
      const done = () => { readyStages[`keys-${provider.name.replace(/[^a-z0-9]+/gi, '_')}`] = Date.now() - providerAt; };
      // A key behind a remote reference is loaded without holding up startup. Only requests that go to this provider
      // wait for it (Router.keyLoading); everyone else is answered at once.
      const remote = isApiKeyConfigurableProvider(provider) && !provider.hasApiKey()
        && !!apiKeyStore.hasArcanaReference?.(apiKeyAccount(provider.name));
      if (!remote) return hydrate().finally(done);
      const loading = hydrate().catch((err) => console.error(`[Leyline] loading ${provider.name}'s key failed`, err)).finally(done);
      router.keyLoading(provider.name, loading);
      background.push(loading.then(() => router.reindexStale()));
    }));
    readyStages.keys = Date.now() - startedAt;
    app.locals.background = Promise.allSettled(background);

    // Lists another instance already made (imported before this ran) are kept until they go stale.
    await router.reindexStale();
    readyStages.lists = Date.now() - startedAt;
  };

  const persistRuntimeConfig = async (provider: RuntimeConfigurableProvider) => {
    const runtime = provider.getRuntimeConfig();
    await apiKeyStore.set(
      runtimeConfigAccount(provider.name),
      serializeRuntimeConfig({
        baseUrl: typeof runtime.baseUrl === 'string' ? runtime.baseUrl : '',
        model: typeof runtime.model === 'string' ? runtime.model : '',
      }),
    );
  };

  const apiKeyInitialization = initializeApiKeys();
  app.locals.ready = apiKeyInitialization.catch(() => undefined);

  // An Arcana phone approval can land after startup/dashboard callers stopped waiting; hydrate
  // providers that are still keyless once it does. The secret value is never logged.
  apiKeyStore.onArcanaResolved?.((account, secret) => {
    void (async () => {
      await apiKeyInitialization;
      const provider = router.getProviders()
        .find(p => isApiKeyConfigurableProvider(p) && apiKeyAccount(p.name) === account);
      if (!provider || !isApiKeyConfigurableProvider(provider) || provider.hasApiKey()) return;
      provider.setApiKey(secret);
      keyMetadata.set(provider.name, { source: 'arcana' });
      delete modelCache[provider.name];
      await router.reindexProvider(provider);
      console.log(`[Leyline] Arcana approval resolved; API key applied for ${provider.name}`);
    })().catch(error => {
      console.warn(`[Leyline] Failed to apply late Arcana key: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  });

  app.get('/readyz', async (_req, res) => {
    await apiKeyInitialization;
    res.json({ status: 'ready', service: 'leyline' });
  });

  const mcpHandler = createMcpHttpHandler();
  // /mcp's chat tool (leyline_chat) is a /v1/chat/completions request: a tool call's arguments become the request
  // body and the chatCompletions handler below answers it, with its JSON wrapped as the tool's result. Nothing else
  // at /mcp reaches a provider.
  const mcpChatTool: express.RequestHandler = (req, res, next) => {
    const call = mcpChatCall(req.body);
    if (call) {
      res.locals.mcpChatCall = call;
      req.body = call.request;
    }
    next();
  };
  app.post('/mcp', mcpChatTool, authMiddleware, async (req, res, next) => {
    await apiKeyInitialization;
    const call = res.locals.mcpChatCall as ReturnType<typeof mcpChatCall>;
    if (!call) return mcpHandler(req, res, next);
    if (!hasMcpSession(req)) return res.status(400).json(MCP_SESSION_REQUIRED);
    answerAsChatTool(res, call.id);
    return chatCompletions(req, res, next);
  });
  // No server-initiated stream here: MCP clients probe GET after initialize, and the spec's answer for that is 405.
  app.get('/mcp', (_req, res) => { res.set('Allow', 'POST, DELETE').status(405).json({ error: 'This server has no GET stream; use POST.' }); });
  app.delete('/mcp', authMiddleware, async (req, res, next) => {
    await apiKeyInitialization;
    return mcpHandler(req, res, next);
  });

  const providerKeyStatus = (provider: ApiKeyConfigurableProvider) => {
    const source = keyMetadata.get(provider.name)?.source || (provider.hasApiKey() ? 'env' : 'none');
    const storeStatus = apiKeyStore.status();
    const runtimeConfig = isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined;
    // A provider served through a platform binding needs no key.
    const runtimeReady = !isRuntimeConfigurableProvider(provider)
      || runtimeConfig?.binding === true
      || Boolean(runtimeConfig?.baseUrlConfigured && provider.hasApiKey());

    const unavailableReason = (provider as unknown as Provider).getUnavailableReason?.();
    return {
      configured: provider.hasApiKey(),
      ...(unavailableReason ? { unavailableReason } : {}),
      source: provider.hasApiKey() ? source : 'none',
      persisted: provider.hasApiKey() && (source === 'keychain' || source === 'arcana'),
      arcanaAvailable: Boolean(
        apiKeyStore.setArcanaReference
        || apiKeyStore.hasArcanaReference?.(apiKeyAccount(provider.name)),
      ),
      arcanaReference: apiKeyStore.getArcanaReference?.(apiKeyAccount(provider.name)),
      keychainAvailable: storeStatus.mode === 'keychain' && storeStatus.available,
      runtimeReady,
    };
  };

  const dashboardPersistenceStatus = () => {
    const storeStatus = apiKeyStore.status();
    return {
      server: storeStatus,
      modes: {
        keychain: {
          available: storeStatus.mode === 'keychain' && storeStatus.available,
          service: storeStatus.service,
          warning: storeStatus.mode === 'keychain' && storeStatus.available ? undefined : storeStatus.warning,
        },
        memory: {
          available: true,
          warning: 'Memory keys are available only until this server process exits.',
        },
        localStorage: {
          available: true,
          warning: 'Browser localStorage is browser-local, less secure than Apple Keychain, and cleared if browser storage is cleared.',
        },
        arcana: {
          available: Boolean(apiKeyStore.setArcanaReference || apiKeyStore.hasArcanaReference?.()),
          warning: 'Arcana references are read-only and must be configured in the environment or Arcana project policy.',
        },
      },
    };
  };

  // Dashboard Stats API
  app.get('/dashboard/stats', async (req, res) => {
    await apiKeyInitialization;
    const stats = quotaManager.getStats();

    const providers = await Promise.all(router.getProviders().map(async p => {
        const pStats = stats[p.name];

        let models: any[] = [];
        const cached = modelCache[p.name];

        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            models = cached.models;
        } else {
            try {
                models = await p.getModels();
                models = models.map(m => ({
                    ...m,
                    capabilities: providerCapabilities(p),
                }));
                modelCache[p.name] = { models, timestamp: Date.now() };
            } catch (e) {
                console.error(`Failed to fetch models for ${p.name}`, e);
                models = [];
            }
        }

        return {
            name: p.name,
            family: p.family,
            label: p.label,
            defaultModel: p.defaultModel,
            apiKeyConfigurable: isApiKeyConfigurableProvider(p),
            apiKeyConfigured: isApiKeyConfigurableProvider(p) ? p.hasApiKey() : undefined,
            apiKeyStatus: isApiKeyConfigurableProvider(p) ? providerKeyStatus(p) : undefined,
            runtimeConfigurable: isRuntimeConfigurableProvider(p),
            runtimeConfig: isRuntimeConfigurableProvider(p) ? p.getRuntimeConfig() : undefined,
            runtimeReady: providerRuntimeReady(p),
            capabilities: providerCapabilities(p),
            models,
            quota: pStats?.quota,
            usage: {
                minute: pStats?.minute || 0,
                day: pStats?.day || 0
            }
        };
    }));

    res.json({
        providers,
        logs: await logger.recent(),
        tunnel: getTunnelInfo?.() ?? { enabled: false, state: 'disabled' },
        clientAuth: {
          enabled: Boolean(config.clientApiKey),
          apiKey: config.clientApiKey || null,
          generated: config.tunnel.enabled && process.env.LEYLINE_CLIENT_API_KEY === undefined && process.env.LEYLINE_CLIENT_AUTH_ENABLED !== 'false',
        },
    });
  });

  app.get('/dashboard/tunnel', (_req, res) => {
    res.json(getTunnelInfo?.() ?? { enabled: false, state: 'disabled' });
  });

  app.get('/dashboard/api-keys', async (_req, res) => {
    await apiKeyInitialization;
    res.json({
      persistence: dashboardPersistenceStatus(),
      routing: dashboardRoutingStatus(router),
      providers: router.getProviders()
        .filter(isApiKeyConfigurableProvider)
        .map(provider => ({
          name: provider.name,
          family: provider.family,
          label: provider.label,
          defaultModel: provider.defaultModel,
          ...providerKeyStatus(provider),
          runtimeConfigurable: isRuntimeConfigurableProvider(provider),
          runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
          runtimeReady: providerRuntimeReady(provider),
          capabilities: providerCapabilities(provider),
        })),
    });
  });

  app.post('/dashboard/api-keys', async (req, res) => {
    await apiKeyInitialization;
    const { provider: providerName, apiKey, baseUrl, model, persistence, arcanaReference } = req.body || {};

    if (!providerName || typeof providerName !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }
    if (arcanaReference !== undefined && typeof arcanaReference !== 'string') {
      return res.status(400).json({ error: 'arcanaReference must be a string' });
    }
    if (persistence !== undefined && !isApiKeyPersistenceMode(persistence)) {
      return res.status(400).json({ error: 'persistence must be keychain, localStorage, memory, or arcana' });
    }

    const provider = router.getProviders()
      .find(p => p.name.toLowerCase() === providerName.toLowerCase());

    if (!provider) {
      return res.status(404).json({ error: `Provider "${providerName}" is not registered` });
    }
    if (!isApiKeyConfigurableProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider.name}" does not support API key overrides` });
    }

    const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : undefined;
    const requestedPersistence: ApiKeyPersistenceMode = persistence || 'keychain';

    if (requestedPersistence === 'arcana') {
      if (arcanaReference?.trim()) {
        if (!apiKeyStore.setArcanaReference) {
          return res.status(400).json({ error: 'Arcana references cannot be configured by this secret store' });
        }
        try {
          apiKeyStore.setArcanaReference(apiKeyAccount(provider.name), arcanaReference.trim());
        } catch (error) {
          return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Arcana reference' });
        }
      }
      const account = apiKeyAccount(provider.name);
      // Choosing Arcana in the dashboard is an explicit user action: skip any failure cooldown.
      apiKeyStore.retryArcana?.(account);
      // get() only blocks for LEYLINE_ARCANA_WAIT_MS; a pending phone approval keeps running and
      // hydrates the provider through onArcanaResolved when it lands.
      const arcanaKey = await apiKeyStore.get(account);
      if (!arcanaKey && apiKeyStore.isArcanaPending?.(account)) {
        return res.status(400).json({
          error: `Arcana approval pending for provider "${provider.name}"; approve the request on your phone and the key will be applied automatically.`,
        });
      }
      if (!arcanaKey || (await apiKeyStore.getSource?.(account)) !== 'arcana') {
        return res.status(400).json({
          error: `No Arcana reference resolved for provider "${provider.name}"`,
        });
      }
      provider.setApiKey(arcanaKey);
      keyMetadata.set(provider.name, { source: 'arcana' });
    } else if (trimmedApiKey) {
      provider.setApiKey(trimmedApiKey);

      if (requestedPersistence === 'keychain') {
        await apiKeyStore.set(apiKeyAccount(provider.name), trimmedApiKey);
        keyMetadata.set(provider.name, { source: apiKeyStore.status().mode });
      } else {
        keyMetadata.set(provider.name, { source: requestedPersistence });
      }
    } else if (trimmedApiKey === '') {
      await apiKeyStore.delete(apiKeyAccount(provider.name));
      provider.setApiKey('');
      keyMetadata.set(provider.name, { source: 'none' });
    }
    if (isRuntimeConfigurableProvider(provider)) {
      provider.setRuntimeConfig({
        baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
        model: typeof model === 'string' ? model : undefined,
      });
      if (typeof baseUrl === 'string' || typeof model === 'string') {
        await persistRuntimeConfig(provider);
      }
    }
    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({
      provider: provider.name,
      ...providerKeyStatus(provider),
      persistence: dashboardPersistenceStatus(),
      runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
    });
  });

  app.delete('/dashboard/api-keys/:provider', async (req, res) => {
    await apiKeyInitialization;
    const providerName = req.params.provider;
    const provider = router.getProviders()
      .find(p => p.name.toLowerCase() === providerName.toLowerCase());

    if (!provider) {
      return res.status(404).json({ error: `Provider "${providerName}" is not registered` });
    }
    if (!isApiKeyConfigurableProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider.name}" does not support API key overrides` });
    }

    await apiKeyStore.delete(apiKeyAccount(provider.name));
    provider.setApiKey('');
    keyMetadata.set(provider.name, { source: 'none' });
    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({
      provider: provider.name,
      ...providerKeyStatus(provider),
      persistence: dashboardPersistenceStatus(),
      runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
    });
  });

  // Routing control: auto vs pinned mode, and the per-model routing pool
  app.get('/dashboard/routing', async (_req, res) => {
    await apiKeyInitialization;
    res.json(dashboardRoutingStatus(router));
  });

  app.post('/dashboard/routing', async (req, res) => {
    await apiKeyInitialization;
    const { mode, pinnedProvider, pinnedModel, enabledModels, modelPins } = req.body || {};

    if (mode !== undefined && mode !== 'auto' && mode !== 'auto-vision' && mode !== 'pinned') {
      return res.status(400).json({ error: "mode must be 'auto', 'auto-vision' or 'pinned'" });
    }
    if (pinnedProvider !== undefined && typeof pinnedProvider !== 'string') {
      return res.status(400).json({ error: 'pinnedProvider must be a string' });
    }
    if (pinnedModel !== undefined && typeof pinnedModel !== 'string') {
      return res.status(400).json({ error: 'pinnedModel must be a string' });
    }

    const registered = new Map(router.getProviders().map(p => [p.name.toLowerCase(), p.name]));
    if (pinnedProvider?.trim() && !registered.has(pinnedProvider.trim().toLowerCase())) {
      return res.status(400).json({ error: `Provider "${pinnedProvider}" is not registered` });
    }

    let sanitizedEnabled: Record<string, string[]> | undefined;
    if (enabledModels !== undefined) {
      sanitizedEnabled = sanitizeEnabledModels(enabledModels);
      if (!sanitizedEnabled) {
        return res.status(400).json({ error: 'enabledModels must map provider names to arrays of model ids' });
      }
      for (const provider of Object.keys(sanitizedEnabled)) {
        if (!registered.has(provider.toLowerCase())) {
          return res.status(400).json({ error: `Provider "${provider}" is not registered` });
        }
      }
    }

    let sanitizedPins: Record<string, string> | undefined;
    if (modelPins !== undefined) {
      sanitizedPins = sanitizeModelPins(modelPins);
      if (!sanitizedPins) {
        return res.status(400).json({ error: 'modelPins must map model ids to provider names' });
      }
      for (const provider of Object.values(sanitizedPins)) {
        if (!registered.has(provider.toLowerCase())) {
          return res.status(400).json({ error: `Provider "${provider}" is not registered` });
        }
      }
    }

    const currentSingle = router.getSingleModel();
    const nextMode: 'auto' | 'pinned' = mode ?? (currentSingle?.enabled ? 'pinned' : 'auto');
    const nextPinnedModel = (pinnedModel ?? currentSingle?.model ?? '').trim();
    if (nextMode === 'pinned' && !nextPinnedModel) {
      return res.status(400).json({ error: 'pinnedModel is required when mode is pinned' });
    }

    applyRoutingConfig({
      mode: nextMode,
      pinnedProvider: (pinnedProvider ?? currentSingle?.provider ?? '').trim(),
      pinnedModel: nextPinnedModel,
      enabledModels: sanitizedEnabled,
      modelPins: sanitizedPins,
    });
    await persistRoutingConfig();

    return res.json(dashboardRoutingStatus(router));
  });

  // ── Generic multi-instance provider management ───────────────────────
  // Lets a family (currently just Azure OpenAI) register more than one
  // configured instance (distinct endpoint/key/etc). The generic routes
  // below know nothing about Azure specifically — they're driven entirely
  // by each family's declared `fields` and their `role` tags.

  function findNamingProvider(): Provider | undefined {
    return router.getProviders().find(p => {
      if (!servesChat(p) || !isApiKeyConfigurableProvider(p) || !p.hasApiKey()) return false;
      const runtimeReady = providerRuntimeReady(p);
      return runtimeReady !== false;
    });
  }

  async function buildNamingAdapter() {
    const namingProvider = findNamingProvider();
    if (!namingProvider) return undefined;
    return {
      async complete(system: string, user: string): Promise<string> {
        const response = await namingProvider.complete({
          model: namingProvider.defaultModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 20,
        });
        return response.choices?.[0]?.message?.content || '';
      },
    };
  }

  app.get('/dashboard/provider-instances', (_req, res) => {
    res.json({
      families: INSTANCE_FAMILIES.map(f => ({
        family: f.family,
        displayName: f.displayName,
        baseName: f.baseName,
        fields: f.fields,
        instances: router.getProviders()
          .filter(p => p.family === f.family && p.name !== f.baseName)
          .map(p => ({ id: p.name.slice(f.baseName.length + 1), name: p.name, label: p.label })),
      })),
    });
  });

  app.post('/dashboard/provider-instances', async (req, res) => {
    await apiKeyInitialization;
    const { family, config: instanceConfig } = req.body || {};

    if (typeof family !== 'string' || !family) {
      return res.status(400).json({ error: 'family is required' });
    }
    const familyDef = INSTANCE_FAMILIES.find(f => f.family === family);
    if (!familyDef) {
      return res.status(404).json({ error: `Unknown provider family "${family}"` });
    }
    if (!instanceConfig || typeof instanceConfig !== 'object') {
      return res.status(400).json({ error: 'config is required' });
    }

    const rawConfig: Record<string, string> = {};
    for (const field of familyDef.fields) {
      const value = (instanceConfig as Record<string, unknown>)[field.key];
      if (value !== undefined && typeof value !== 'string') {
        return res.status(400).json({ error: `config.${field.key} must be a string` });
      }
      // Secret fields are set afterward via the existing /dashboard/api-keys card (same
      // persistence-mode UI every other provider uses), not collected at creation time.
      if (field.required && field.role !== 'secret' && !value?.trim()) {
        return res.status(400).json({ error: `config.${field.key} is required` });
      }
      rawConfig[field.key] = typeof value === 'string' ? value.trim() : '';
    }

    const existingIds = new Set(
      router.getProviders()
        .filter(p => p.family === familyDef.family && p.name !== familyDef.baseName)
        .map(p => p.name.slice(familyDef.baseName.length + 1)),
    );
    const llm = await buildNamingAdapter();
    const id = await generateInstanceId(familyDef.namingHint(rawConfig), existingIds, llm);

    const provider = familyDef.create({ ...rawConfig, id, label: id });
    router.addProvider(provider);

    for (const field of familyDef.fields) {
      if (field.role === 'secret' && rawConfig[field.key]) {
        await apiKeyStore.set(apiKeyAccount(provider.name), rawConfig[field.key]);
        if (isApiKeyConfigurableProvider(provider)) {
          keyMetadata.set(provider.name, { source: apiKeyStore.status().mode });
        }
      }
    }
    if (isRuntimeConfigurableProvider(provider)) {
      const baseUrlField = familyDef.fields.find(f => f.role === 'runtimeBaseUrl');
      const modelField = familyDef.fields.find(f => f.role === 'runtimeModel');
      provider.setRuntimeConfig({
        baseUrl: baseUrlField ? rawConfig[baseUrlField.key] : undefined,
        model: modelField ? rawConfig[modelField.key] : undefined,
      });
      await persistRuntimeConfig(provider);
    }

    const extra: Record<string, string> = {};
    for (const field of familyDef.fields) {
      if (field.role === 'extra' && rawConfig[field.key]) extra[field.key] = rawConfig[field.key];
    }

    const manifestRaw = await apiKeyStore.get(instanceManifestAccount(familyDef.family));
    const manifest = manifestRaw ? parseInstanceManifest(manifestRaw) : [];
    manifest.push({ id, label: id, extra });
    await apiKeyStore.set(instanceManifestAccount(familyDef.family), serializeInstanceManifest(manifest));

    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({ name: provider.name, id, label: provider.label });
  });

  app.delete('/dashboard/provider-instances/:family/:id', async (req, res) => {
    await apiKeyInitialization;
    const familyDef = INSTANCE_FAMILIES.find(f => f.family === req.params.family);
    if (!familyDef) {
      return res.status(404).json({ error: `Unknown provider family "${req.params.family}"` });
    }
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const name = `${familyDef.baseName}:${id}`;
    const provider = router.getProviders().find(p => p.name === name);
    if (!provider) {
      return res.status(404).json({ error: `Instance "${id}" is not registered for ${familyDef.family}` });
    }

    router.removeProvider(name);
    await apiKeyStore.delete(apiKeyAccount(name));
    await apiKeyStore.delete(runtimeConfigAccount(name));
    keyMetadata.delete(name);
    delete modelCache[name];

    const manifestRaw = await apiKeyStore.get(instanceManifestAccount(familyDef.family));
    const manifest = (manifestRaw ? parseInstanceManifest(manifestRaw) : []).filter(entry => entry.id !== id);
    await apiKeyStore.set(instanceManifestAccount(familyDef.family), serializeInstanceManifest(manifest));

    await persistRoutingConfig();

    return res.json({ removed: true });
  });

  // Chat completions, with provider failover.
  const chatCompletions: express.RequestHandler = async (req, res) => {
    await apiKeyInitialization;
    const request = normalizeCompletionRequest(req.body);

    if (request.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'At least one message is required',
          type: 'invalid_request_error',
          code: 'missing_messages',
        },
      });
    }

    const forceProviderHeader = req.headers['x-leyline-force-provider'];
    const forceProvider = typeof forceProviderHeader === 'string' && forceProviderHeader.trim()
      ? forceProviderHeader.trim()
      : undefined;
    if (forceProvider && !router.getProviders().some(p => p.name === forceProvider)) {
      return res.status(400).json({
        error: {
          message: `Provider "${forceProvider}" is not registered`,
          type: 'invalid_request_error',
          code: 'unknown_provider',
        },
      });
    }
    const routeOptions = forceProvider ? { forceProvider } : {};

    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        for await (const chunk of await router.routeStream(request, routeOptions)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json(await router.route(request, routeOptions));
      }
    } catch (error: any) {
      const hydrated = await hydrateAxiosError(error);
      console.error('API Error:', formatProviderError(hydrated));
      const { status, body } = chatCompletionErrorResponse(hydrated);
      if (res.headersSent) {
        res.end();
        return;
      }
      // The provider failed (not a refusal before routing): /mcp's chat tool answers this as a tool error.
      res.locals.providerFailed = true;
      // A stream that failed before its first chunk answers as JSON, not under the text/event-stream type set for it.
      res.status(status).type('json').json(body);
    }
  };
  app.post('/v1/chat/completions', authMiddleware, chatCompletions);

  // OpenAI Responses API (OpenAI Codex CLI speaks only this): translated to a chat request and routed like
  // /v1/chat/completions above, the result translated back (src/core/responses.ts). Stateless: previous_response_id
  // is refused with a 400.
  app.post('/v1/responses', authMiddleware, async (req, res) => {
    await apiKeyInitialization;
    const invalid = (status: number, message: string, code: string, param: string | null = null) =>
      res.status(status).json({ error: { message, type: 'invalid_request_error', code, param } });
    let translated;
    try {
      translated = responsesToChat(req.body as ResponsesRequest);
    } catch (err) {
      if (err instanceof ResponsesRequestError) return invalid(400, err.message, err.code, err.param);
      throw err;
    }
    const { request, tools } = translated;
    if (request.messages.length === 0) return invalid(400, 'input is required: at least one message.', 'missing_required_parameter', 'input');
    const echo = { model: request.model, request: req.body as ResponsesRequest };
    // Usage as the provider reported it, else estimated (four characters a token).
    const counted = (usage: TokenUsage | undefined, outChars: number) => usageOrEstimate(req.body, usage, outChars);

    if (request.stream) {
      const out = new ResponsesStream(echo, tools);
      try {
        // The SSE headers go out with the first event, so a provider that fails before its first chunk still gets a
        // plain JSON error with its status.
        const send = (events: ReturnType<ResponsesStream['push']>) => {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
          }
          for (const e of events) res.write(sse(e));
        };
        for await (const chunk of await router.routeStream(request, {})) send(out.push(chunk));
        send(out.end(counted(out.reportedUsage, out.chars)));
        res.end();
      } catch (error: any) {
        const hydrated = await hydrateAxiosError(error);
        console.error('/v1/responses Error:', formatProviderError(hydrated));
        const { status, body } = chatCompletionErrorResponse(hydrated);
        if (!res.headersSent) {
          // Nothing streamed yet: answer with the status, as JSON, like a non-streaming request.
          res.status(status).type('json').json(body);
          return;
        }
        // Partway through: the client is told the response failed.
        for (const e of out.fail('The model provider failed partway through this response; try again.')) res.write(sse(e));
        res.end();
      }
      return;
    }

    try {
      const response = await router.route(request, {});
      res.json(chatToResponse(response, echo, tools, counted(response.usage, completionChars(response))));
    } catch (error: any) {
      const hydrated = await hydrateAxiosError(error);
      console.error('/v1/responses Error:', formatProviderError(hydrated));
      const { status, body } = chatCompletionErrorResponse(hydrated);
      if (!res.headersSent) res.status(status).type('json').json(body);
      else res.end();
    }
  });

  // ── NEW: Routing decision endpoint ───────────────────────────────────
  // Returns a full routing decision (tier, model, provider, classification)
  // for a user message. Used by agent pipelines to decide which model to
  // use before dispatching a request.
  app.post('/v1/route', authMiddleware, async (req, res) => {
    await apiKeyInitialization;
    const { user_message, chat_history } = req.body || {};
    if (!user_message) {
      return res.status(400).json({ error: 'user_message is required' });
    }

    try {
      const classifyReq: ClassifyRequest = {
        userMessage: user_message,
        chatHistory: chat_history,
      };
      const result = await router.resolveRoute(classifyReq);
      return res.json(result);
    } catch (error: any) {
      console.error('/v1/route Error:', error.message);
      return res.status(500).json({
        error: 'Routing failed: ' + error.message,
      });
    }
  });

  // Embeddings, speech-to-text, text-to-speech, images and video (src/core/media-routes.ts).
  mountMediaRoutes(app, router, { auth: authMiddleware, ready: apiKeyInitialization, bodyLimit: config.bodyLimit });

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const payloadError = err as { type?: string; status?: number; message?: string };
    if (payloadError?.type === 'entity.too.large' || payloadError?.status === 413) {
      return res.status(413).json({
        error: {
          message: `Request body exceeds Leyline limit (${config.bodyLimit}). Set LEYLINE_BODY_LIMIT to raise it.`,
          type: 'invalid_request_error',
          code: 'payload_too_large',
        },
      });
    }
    next(err);
  });

  return app;
};

export interface StartServerOptions extends CreateServerOptions {
  port?: number;
}

export function startServer(
  router: Router,
  quotaManager: QuotaManager,
  options: StartServerOptions = {},
): Promise<HttpServer> {
  const app = createServer(router, quotaManager, options);
  const port = options.port ?? config.port;
  const host = options.host ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
