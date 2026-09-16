import { PROVIDER_IDS, PROVIDER_LABELS, type ProviderId, type ProviderStatus } from '../../shared/types.ts';
import { apiKeyFor, KEY_REQUIRED } from '../env.ts';
import type { SettingsService } from '../services/settings.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAiCompatibleProvider } from './openaiCompatible.ts';
import { ProviderError, type Provider } from './types.ts';

export class ProviderRegistry {
  private readonly settings: SettingsService;

  constructor(settings: SettingsService) {
    this.settings = settings;
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
