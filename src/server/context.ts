import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { Repos } from './db/repos.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { ChatService } from './services/chat.ts';
import type { MemoryService } from './services/memory.ts';
import type { SettingsService } from './services/settings.ts';
import type { UsageService } from './services/usage.ts';

export interface Services {
  repos: Repos;
  settings: SettingsService;
  registry: ProviderRegistry;
  memory: MemoryService;
  chat: ChatService;
  usage: UsageService;
}

export function badRequest(message: string): HTTPException {
  return new HTTPException(400, { message });
}

export function notFound(what: string): HTTPException {
  return new HTTPException(404, { message: `${what} not found` });
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== 'object' || body === null) throw new Error('not an object');
    return body as T;
  } catch {
    throw badRequest('Expected a JSON object body');
  }
}

/** Copies only the listed keys that are present, so PATCH bodies cannot write arbitrary columns. */
export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
