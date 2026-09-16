import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import type { AppSettings, SettingsSection } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges stored values over defaults so new settings keys appear without a migration. */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (stored === undefined || stored === null) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(stored)) return stored as T;
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    result[key] = key in defaults ? mergeDefaults((defaults as Record<string, unknown>)[key], value) : value;
  }
  return result as T;
}

export class SettingsService {
  private cache: AppSettings | null = null;
  private readonly repos: Repos;

  constructor(repos: Repos) {
    this.repos = repos;
  }

  async getAll(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const rows = await this.repos.settings.findMany();
    const stored = Object.fromEntries(rows.map((row) => [row.id, row.value]));
    this.cache = mergeDefaults(DEFAULT_SETTINGS, stored);
    return this.cache;
  }

  async get<K extends SettingsSection>(section: K): Promise<AppSettings[K]> {
    return (await this.getAll())[section];
  }

  async set<K extends SettingsSection>(section: K, value: AppSettings[K]): Promise<AppSettings> {
    if (!(section in DEFAULT_SETTINGS)) throw new Error(`Unknown settings section "${section}"`);
    const merged = mergeDefaults(DEFAULT_SETTINGS[section], value);
    const existing = await this.repos.settings.findById(section);
    if (existing) await this.repos.settings.update(section, { value: merged });
    else await this.repos.settings.create({ id: section, value: merged });
    this.cache = null;
    return this.getAll();
  }

  async replaceAll(settings: Partial<AppSettings>): Promise<AppSettings> {
    for (const section of Object.keys(settings) as SettingsSection[]) {
      if (section in DEFAULT_SETTINGS) await this.set(section, settings[section] as AppSettings[typeof section]);
    }
    return this.getAll();
  }
}
