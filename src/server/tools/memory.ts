import { randomUUID } from 'node:crypto';
import type { MemoryService, MatchResult } from '../services/memory.ts';
import type { ToolDefinition, ToolGroup, ToolResult, ToolRunContext, ToolSource } from './types.ts';

export const MEMORY_GROUP: ToolGroup = {
  id: 'memory',
  label: 'Memory',
  description: 'Save, update and forget facts about you. Follows each chat’s Memory toggle.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: 'useMemory',
};

function argText(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string).trim().slice(0, 500) : '';
}

function ambiguous(result: MatchResult, query: string, tool: string): ToolResult {
  return {
    content:
      result.candidates.length === 0
        ? `Error: no memory matches "${query}".`
        : `Error: several memories match. Call ${tool} again with the full text of one:\n${result.candidates.map((memory) => `- ${memory.content}`).join('\n')}`,
    isError: true,
  };
}

function failure(result: MatchResult): string {
  return result.candidates.length === 0 ? 'No matching memory' : `${result.candidates.length} memories match`;
}

type MemoryStep = (args: Record<string, unknown>, context: ToolRunContext, id: string) => Promise<ToolResult>;

/** Wraps a memory action with its start and finish activity. */
function step(action: 'save' | 'forget' | 'update' | 'list', label: string, run: MemoryStep): ToolDefinition['run'] {
  return async (args, context) => {
    const id = randomUUID();
    const content = argText(args, 'content') || argText(args, 'memory') || (action === 'list' ? 'All memories' : '');
    context.onActivity({ id, kind: 'memory', action, content, done: false });
    try {
      return await run(args, context, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.onActivity({ id, kind: 'memory', action, content, done: true, error: message });
      return { content: `Error: ${label} failed: ${message}`, isError: true };
    }
  };
}

export function memoryTools(memory: MemoryService): ToolSource {
  const save: ToolDefinition = {
    group: 'memory',
    label: 'Save to memory',
    defaultPolicy: 'auto',
    ownActivity: true,
    spec: {
      name: 'memory_save',
      description:
        'Save a durable fact about the user to long-term memory, so it is available in future conversations. ' +
        'Call it whenever the user asks you to remember something, and for lasting preferences, background or standing instructions they share. ' +
        'Write the fact as a short standalone sentence in the third person, e.g. "Prefers metric units".',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 2, description: 'The fact to remember, one short sentence' },
          category: { type: 'string', description: 'A short category such as preferences, background, projects or instructions' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    run: step('save', 'Saving', async (args, context, id) => {
      const content = argText(args, 'content');
      const category = argText(args, 'category').toLowerCase().slice(0, 40) || 'general';
      const stored = await memory.save(content, category, context.conversationId);
      context.onActivity({ id, kind: 'memory', action: 'save', content, done: true });
      return { content: stored ? `Saved to memory: "${content}"` : `Already in memory: "${content}"`, isError: false };
    }),
  };

  const forget: ToolDefinition = {
    group: 'memory',
    label: 'Forget a memory',
    defaultPolicy: 'auto',
    ownActivity: true,
    spec: {
      name: 'memory_forget',
      description:
        'Remove a fact from long-term memory when the user asks you to forget it or says it is no longer true. ' +
        'Pass the memory text as it appears in your memory list, or a distinctive part of it.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 2, description: 'The memory to remove, or a distinctive part of its text' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    run: step('forget', 'Forgetting', async (args, context, id) => {
      const content = argText(args, 'content');
      const result = await memory.forget(content);
      if (!result.match) {
        context.onActivity({ id, kind: 'memory', action: 'forget', content, done: true, error: failure(result) });
        return ambiguous(result, content, 'memory_forget');
      }
      context.onActivity({ id, kind: 'memory', action: 'forget', content: result.match.content, done: true });
      return { content: `Removed from memory: "${result.match.content}"`, isError: false };
    }),
  };

  const update: ToolDefinition = {
    group: 'memory',
    label: 'Update a memory',
    defaultPolicy: 'auto',
    ownActivity: true,
    spec: {
      name: 'memory_update',
      description:
        'Rewrite a fact in long-term memory when it has changed, e.g. the user moved or changed a preference. ' +
        'Prefer this to saving a second, conflicting fact.',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', minLength: 2, description: 'The current memory text, or a distinctive part of it' },
          content: { type: 'string', minLength: 2, description: 'The new text, one short sentence' },
        },
        required: ['memory', 'content'],
        additionalProperties: false,
      },
    },
    run: step('update', 'Updating', async (args, context, id) => {
      const target = argText(args, 'memory');
      const content = argText(args, 'content');
      const result = await memory.update(target, content);
      if (!result.match) {
        context.onActivity({ id, kind: 'memory', action: 'update', content: target, done: true, error: failure(result) });
        return ambiguous(result, target, 'memory_update');
      }
      context.onActivity({ id, kind: 'memory', action: 'update', content, done: true });
      return { content: `Updated memory: "${result.match.content}" is now "${content}"`, isError: false };
    }),
  };

  const list: ToolDefinition = {
    group: 'memory',
    label: 'List memories',
    defaultPolicy: 'auto',
    ownActivity: true,
    spec: {
      name: 'memory_list',
      description:
        'List everything in long-term memory, including facts left out of your prompt and paused ones. ' +
        'Use it when the user asks what you remember.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Only list this category' },
        },
        additionalProperties: false,
      },
    },
    run: step('list', 'Listing', async (args, context, id) => {
      const category = argText(args, 'category').toLowerCase();
      const rows = (await memory.list()).filter((row) => !category || row.category === category);
      context.onActivity({ id, kind: 'memory', action: 'list', content: `${rows.length} memories`, done: true });
      if (rows.length === 0) return { content: 'Memory is empty.', isError: false };
      const lines = rows.map((row) => `- [${row.category}] ${row.content}${row.enabled ? '' : ' (paused by the user)'}`);
      return { content: lines.join('\n'), isError: false };
    }),
  };

  return {
    groups: async () => [MEMORY_GROUP],
    tools: async () => [save, update, forget, list],
  };
}
