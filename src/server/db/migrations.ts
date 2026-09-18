import type { Logger } from '../log.ts';
import type { Repos } from './repos.ts';

/**
 * Versioned data migrations. New columns are added by `addMissingColumns` and new tables by
 * repolayer's ensureTable(), so these steps cover what neither can: reshaping data that already
 * exists. Each step runs once, in order, and the version reached is stored in the settings table.
 * Add new steps at the end with the next version number, and never change one that has shipped.
 */
export interface Migration {
  version: number;
  name: string;
  up(context: { repos: Repos; log: Logger }): Promise<void>;
}

export const SCHEMA_VERSION_ROW = '_schema_version';

/** Starter profiles that gained the workspace groups after they were first seeded. */
const STARTER_PROFILES_WITH_WORKSPACE = ['Coding assistant', 'Data analyst'];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'move the tool round limit from web settings to agent settings',
    async up({ repos }) {
      const web = await repos.settings.findById('web');
      const value = web?.value as Record<string, unknown> | undefined;
      if (!value || !('maxToolRounds' in value)) return;
      const { maxToolRounds, ...rest } = value;
      if (!(await repos.settings.findById('agent'))) {
        await repos.settings.create({ id: 'agent', value: { maxToolRounds } });
      }
      await repos.settings.update('web', { value: rest });
    },
  },
  {
    version: 2,
    name: 'let the coding and data starter profiles use workspace files and commands',
    async up({ repos }) {
      for (const name of STARTER_PROFILES_WITH_WORKSPACE) {
        for (const profile of await repos.systemPrompts.findMany({ where: { name } })) {
          const tools = profile.tools as string[] | null;
          // Null already allows every group.
          if (!Array.isArray(tools) || tools.includes('files')) continue;
          await repos.systemPrompts.update(profile.id, { tools: [...tools, 'files', 'commands'] });
        }
      }
    },
  },
];

export async function schemaVersion(repos: Repos): Promise<number> {
  const value = (await repos.settings.findById(SCHEMA_VERSION_ROW))?.value as { version?: unknown } | undefined;
  return typeof value?.version === 'number' ? value.version : 0;
}

/** Runs the migrations newer than the stored version and returns the names of those that ran. */
export async function runMigrations(repos: Repos, log: Logger, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  const current = await schemaVersion(repos);
  const ran: string[] = [];
  for (const migration of migrations.toSorted((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    await migration.up({ repos, log });
    const value = { version: migration.version, name: migration.name, migratedAt: new Date().toISOString() };
    if (await repos.settings.findById(SCHEMA_VERSION_ROW)) await repos.settings.update(SCHEMA_VERSION_ROW, { value });
    else await repos.settings.create({ id: SCHEMA_VERSION_ROW, value });
    log.info('migrated', { version: migration.version, step: migration.name });
    ran.push(migration.name);
  }
  return ran;
}
