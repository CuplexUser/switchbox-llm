import { PROVIDER_IDS, PROVIDER_LABELS, type ModelInfo, type ProviderId, type ProviderStatus } from '../../shared/types.ts';
import { apiKeyFor, KEY_REQUIRED } from '../env.ts';
import type { SettingsService } from '../services/settings.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GoogleProvider } from './google.ts';
import { OpenAiCompatibleProvider } from './openaiCompatible.ts';
import { ProviderError, type Provider } from './types.ts';

const MODEL_CACHE_MS = 10 * 60 * 1000;

export class ProviderRegistry {
  private readonly settings: SettingsService;
  private readonly modelCache = new Map<ProviderId, { at: number; models: ModelInfo[] }>();

  constructor(settings: SettingsService) {
    this.settings = settings;
  }

  /** Remembers a model list, e.g. after a connection test. */
  cacheModels(id: ProviderId, models: ModelInfo[]): void {
    this.modelCache.set(id, { at: Date.now(), models });
  }

  clearModelCache(): void {
    this.modelCache.clear();
  }

  /** A provider's models, from a cache kept for ten minutes. */
  async models(id: ProviderId, refresh = false): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
    const models = await (await this.get(id)).listModels(AbortSignal.timeout(15_000));
    this.cacheModels(id, models);
    return models;
  }

  /** The last list fetched, however old, without touching the network. */
  cachedModels(id: ProviderId): ModelInfo[] {
    return this.modelCache.get(id)?.models ?? [];
  }

  cachedModel(id: ProviderId, model: string): ModelInfo | null {
    return this.cachedModels(id).find((entry) => entry.model === model) ?? null;
  }

  async statuses(): Promise<ProviderStatus[]> {
    const providers = await this.settings.get('providers');
    return PROVIDER_IDS.map((id) => {
      const { enabled, baseUrl } = providers[id];
      const keyConfigured = apiKeyFor(id) !== null;
      const requiresKey = KEY_REQUIRED[id];
      return {
        id,
        label: PROVIDER_LABELS[id],
        enabled,
        baseUrl,
        requiresKey,
        keyConfigured,
        ready: enabled && Boolean(baseUrl) && (!requiresKey || keyConfigured),
      };
    });
  }

  /** Builds a provider from the current settings, even when disabled, so it can be tested. */
  async build(id: ProviderId): Promise<Provider> {
    const { baseUrl } = (await this.settings.get('providers'))[id];
    const apiKey = apiKeyFor(id);
    if (id === 'anthropic') return new AnthropicProvider({ baseUrl, apiKey });
    if (id === 'google') return new GoogleProvider({ baseUrl, apiKey });
    return new OpenAiCompatibleProvider({ id, baseUrl, apiKey });
  }

  /** A provider that is ready for chat, or a clear reason why it is not. */
  async get(id: ProviderId): Promise<Provider> {
    const status = (await this.statuses()).find((entry) => entry.id === id);
    if (!status) throw new ProviderError(`Unknown provider "${id}"`);
    if (!status.enabled) throw new ProviderError(`${status.label} is disabled. Enable it in Settings → Providers.`);
    if (!status.baseUrl) throw new ProviderError(`${status.label} has no base URL. Set one in Settings → Providers.`);
    if (status.requiresKey && !status.keyConfigured) {
      throw new ProviderError(`${status.label} needs an API key. Add it to .env and restart the server.`);
    }
    return this.build(id);
  }
}
