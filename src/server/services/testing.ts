import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, ProviderId, StreamEvent, StreamRequest } from '../../shared/types.ts';
import { createServices } from '../app.ts';
import type { Services } from '../context.ts';
import { memoryRepos, type Repos } from '../db/repos.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ChatEvent, ChatRequest, Provider } from '../providers/types.ts';
import { McpManager } from '../tools/mcp.ts';
import type { ToolSource } from '../tools/types.ts';

/** A provider that answers each request from a script and records what it was sent. */
export class FakeProvider implements Provider {
  readonly id: ProviderId = 'openrouter';
  readonly requests: ChatRequest[] = [];
  private readonly reply: (request: ChatRequest) => ChatEvent[] | Promise<ChatEvent[]>;

  constructor(reply: (request: ChatRequest) => ChatEvent[] | Promise<ChatEvent[]>) {
    this.reply = reply;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    // Copies, so later changes to the loop's arrays don't rewrite what was recorded.
    this.requests.push({ ...request, messages: [...request.messages] });
    for (const event of await this.reply(request)) {
      if (request.signal.aborted) return;
      yield event;
    }
  }
}

export function fakeRegistry(provider: Provider): ProviderRegistry {
  return {
    get: async () => provider,
    build: async () => provider,
    cachedModel: () => null,
    cachedModels: () => [],
  } as unknown as ProviderRegistry;
}

/** A fresh folder for one test's workspaces. */
export function tempWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'switchbox-workspaces-'));
}

export function setup(provider: Provider, toolSources: ToolSource[] = []): Services {
  const repos: Repos = memoryRepos();
  return createServices(repos, { registry: fakeRegistry(provider), mcp: new McpManager(), toolSources, workspaceDir: tempWorkspaceDir() });
}

export async function seedConversation(
  repos: Repos,
  options: { persist?: boolean; useMemory?: boolean; webAccess?: boolean; workspace?: boolean; toolGroups?: Record<string, boolean> | null } = {},
) {
  const conversation = await repos.conversations.create({
    title: 'New chat',
    persist: options.persist ?? true,
    useMemory: options.useMemory ?? true,
    webAccess: options.webAccess ?? false,
    workspace: options.workspace ?? false,
    toolGroups: options.toolGroups ?? null,
    pinned: false,
    archived: false,
  });
  const pane = await repos.panes.create({
    conversationId: conversation.id,
    position: 0,
    provider: 'openrouter',
    model: 'test/model',
    systemPromptId: null,
    systemPrompt: 'You are terse.',
    params: { temperature: 0.3 },
  });
  return { conversation, pane };
}

export async function send(
  services: Services,
  conversationId: string,
  paneIds: string[],
  content: string,
  extra: Partial<StreamRequest> = {},
  controllers = new Map<string, AbortController>(),
  onEvent?: (event: StreamEvent) => void,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await services.chat.run(
    { runId: `run-${Math.random()}`, conversationId, action: 'send', content, paneIds, ...extra },
    (event) => {
      events.push(event);
      onEvent?.(event);
    },
    controllers,
  );
  return events;
}

export function doneMessage(events: StreamEvent[]) {
  const done = events.findLast((event) => event.type === 'done' || event.type === 'error');
  return done && (done.type === 'done' || done.type === 'error') ? done.message : null;
}
