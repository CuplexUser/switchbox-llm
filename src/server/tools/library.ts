import type { Repos } from '../db/repos.ts';
import { decodeText } from '../services/attachments.ts';
import type { SearchService } from '../services/search.ts';
import type { ToolDefinition, ToolGroup, ToolSource } from './types.ts';

export const HISTORY_GROUP: ToolGroup = {
  id: 'history',
  label: 'Search earlier chats',
  description: 'Look up what was said in other saved chats.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: null,
};

export const ATTACHMENTS_GROUP: ToolGroup = {
  id: 'attachments',
  label: 'Read attached files',
  description: 'Read long text files attached to the chat past the part included in the prompt.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: null,
};

const READ_DEFAULT = 20_000;
const READ_MAX = 50_000;

export function libraryTools(repos: Repos, search: SearchService): ToolSource {
  const conversationSearch: ToolDefinition = {
    group: 'history',
    label: 'Search earlier chats',
    defaultPolicy: 'auto',
    spec: {
      name: 'conversation_search',
      description:
        'Search the user’s other saved chats for messages containing all of the given words. ' +
        'Use it when the user refers to something discussed before, e.g. "what did we decide about the database last week?"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, description: 'Words to look for; every word must appear in a message' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Most results to return (default 8)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(args, context) {
      const hits = await search.messages(String(args.query), {
        limit: typeof args.limit === 'number' ? args.limit : 8,
        excludeConversationId: context.conversationId,
      });
      if (hits.length === 0) return { content: `No messages in other saved chats contain "${String(args.query)}".`, isError: false };
      const lines = hits.map(
        (hit) => `- "${hit.conversationTitle}", ${hit.createdAt.slice(0, 10)}, ${hit.role === 'user' ? 'user' : 'assistant'}: ${hit.snippet}`,
      );
      return { content: `Matches from earlier chats:\n${lines.join('\n')}`, isError: false };
    },
  };

  const readAttachment: ToolDefinition = {
    group: 'attachments',
    label: 'Read an attached file',
    defaultPolicy: 'auto',
    spec: {
      name: 'read_attachment',
      description:
        'Read part of a text file attached to this chat, by the id shown in its <attachment> tag. ' +
        'Use it when a file was cut short in the conversation.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The attachment id' },
          offset: { type: 'integer', minimum: 0, description: 'Character to start at (default 0)' },
          length: { type: 'integer', minimum: 1, maximum: READ_MAX, description: `Characters to read (default ${READ_DEFAULT})` },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    available: (environment) => environment.attachments.some((attachment) => attachment.kind === 'text'),
    async run(args, context) {
      const id = String(args.id);
      if (!context.attachments.some((attachment) => attachment.id === id)) {
        return { content: `Error: no file with id "${id}" is attached to this chat.`, isError: true };
      }
      const row = await repos.attachments.findById(id);
      if (!row || row.kind !== 'text') return { content: `Error: "${id}" is not a readable text file.`, isError: true };
      const text = decodeText(row.data);
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const length = typeof args.length === 'number' ? args.length : READ_DEFAULT;
      const slice = text.slice(offset, offset + length);
      const end = offset + slice.length;
      const note = end < text.length ? `\n[Characters ${offset}–${end} of ${text.length}. Continue with offset ${end}.]` : `\n[End of file, ${text.length} characters.]`;
      return { content: `${row.name}\n\n${slice}${note}`, isError: false };
    },
  };

  return {
    groups: async () => [HISTORY_GROUP, ATTACHMENTS_GROUP],
    tools: async () => [conversationSearch, readAttachment],
  };
}
