import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppSettings,
  Conversation,
  ConversationDetail,
  Memory,
  MemoryStatus,
  Message,
  ModelInfo,
  ModelRef,
  Pane,
  PromptPreview,
  ProviderId,
  ProviderStatus,
  SettingsSection,
  SystemPrompt,
  WebStatus,
} from '../../shared/types.ts';
import { api } from './client.ts';

export const keys = {
  settings: ['settings'] as const,
  providers: ['providers'] as const,
  webStatus: ['web-status'] as const,
  models: ['models'] as const,
  prompts: ['prompts'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  messages: (id: string) => ['messages', id] as const,
  memories: (status?: MemoryStatus) => ['memories', status ?? 'all'] as const,
  pendingCount: ['memories', 'pending-count'] as const,
};

// Settings and providers

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api<AppSettings>('/settings'), staleTime: Infinity });
}

export type SettingsUpdate = { [K in SettingsSection]: { section: K; value: AppSettings[K] } }[SettingsSection];

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ section, value }: SettingsUpdate) =>
      api<AppSettings>(`/settings/${section}`, { method: 'PUT', json: value }),
    onMutate: async ({ section, value }) => {
      await client.cancelQueries({ queryKey: keys.settings });
      const previous = client.getQueryData<AppSettings>(keys.settings);
      if (previous) client.setQueryData(keys.settings, { ...previous, [section]: value });
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(keys.settings, context.previous);
    },
    onSuccess: (settings, { section }) => {
      client.setQueryData(keys.settings, settings);
      if (section === 'web') void client.invalidateQueries({ queryKey: keys.webStatus });
      if (section === 'providers') {
        void client.invalidateQueries({ queryKey: keys.providers });
        void client.invalidateQueries({ queryKey: keys.models });
      }
    },
  });
}

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => api<ProviderStatus[]>('/providers') });
}

export function useWebStatus() {
  return useQuery({ queryKey: keys.webStatus, queryFn: () => api<WebStatus>('/web/status') });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: ProviderId) =>
      api<{ ok: boolean; modelCount?: number; latencyMs?: number; error?: string }>(`/providers/${id}/test`, {
        method: 'POST',
      }),
  });
}

export interface ModelsResponse {
  models: ModelInfo[];
  errors: { provider: ProviderId; error: string }[];
}

export function useModels() {
  return useQuery({
    queryKey: keys.models,
    queryFn: () => api<ModelsResponse>('/models'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useRefreshModels() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<ModelsResponse>('/models?refresh=1'),
    onSuccess: (data) => client.setQueryData(keys.models, data),
  });
}

// Prompts

export function usePrompts() {
  return useQuery({ queryKey: keys.prompts, queryFn: () => api<SystemPrompt[]>('/prompts') });
}

export function useSavePrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prompt: Partial<SystemPrompt>) =>
      prompt.id
        ? api<SystemPrompt>(`/prompts/${prompt.id}`, { method: 'PATCH', json: prompt })
        : api<SystemPrompt>('/prompts', { method: 'POST', json: prompt }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.prompts }),
  });
}

export function useDeletePrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/prompts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.prompts }),
  });
}

// Conversations and panes

export function useConversations() {
  return useQuery({ queryKey: keys.conversations, queryFn: () => api<Conversation[]>('/conversations') });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: () => api<ConversationDetail>(`/conversations/${id}`),
    enabled: Boolean(id),
    retry: false,
  });
}

export function useConversationMessages(id: string | undefined) {
  return useQuery({
    queryKey: keys.messages(id ?? ''),
    queryFn: () => api<Message[]>(`/conversations/${id}/messages`),
    enabled: Boolean(id),
    staleTime: Infinity,
    retry: false,
  });
}

export interface NewConversation {
  title?: string;
  persist?: boolean;
  useMemory?: boolean;
  webAccess?: boolean;
  panes: (ModelRef & { systemPromptId?: string | null })[];
}

export function useCreateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: NewConversation) => api<ConversationDetail>('/conversations', { method: 'POST', json: body }),
    onSuccess: (conversation) => {
      client.setQueryData(keys.conversation(conversation.id), conversation);
      client.setQueryData(keys.messages(conversation.id), []);
      void client.invalidateQueries({ queryKey: keys.conversations });
    },
  });
}

export function useUpdateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: Partial<Conversation> & { id: string }) =>
      api<ConversationDetail>(`/conversations/${id}`, { method: 'PATCH', json: changes }),
    onSuccess: (conversation) => {
      client.setQueryData(keys.conversation(conversation.id), conversation);
      void client.invalidateQueries({ queryKey: keys.conversations });
    },
  });
}

export function useDeleteConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      client.removeQueries({ queryKey: keys.conversation(id) });
      client.removeQueries({ queryKey: keys.messages(id) });
      void client.invalidateQueries({ queryKey: keys.conversations });
    },
  });
}

function patchPanes(
  client: ReturnType<typeof useQueryClient>,
  conversationId: string,
  update: (panes: Pane[]) => Pane[],
): void {
  client.setQueryData<ConversationDetail>(keys.conversation(conversationId), (current) =>
    current ? { ...current, panes: update(current.panes) } : current,
  );
}

export function useAddPane() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, ...body }: ModelRef & { conversationId: string }) =>
      api<Pane>(`/conversations/${conversationId}/panes`, { method: 'POST', json: body }),
    onSuccess: (pane) => patchPanes(client, pane.conversationId, (panes) => [...panes, pane]),
  });
}

export function useUpdatePane() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: Partial<Pane> & { id: string }) =>
      api<Pane>(`/panes/${id}`, { method: 'PATCH', json: changes }),
    onSuccess: (pane) =>
      patchPanes(client, pane.conversationId, (panes) => panes.map((entry) => (entry.id === pane.id ? pane : entry))),
  });
}

export function useRemovePane() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pane: Pane) => api<void>(`/panes/${pane.id}`, { method: 'DELETE' }),
    onSuccess: (_data, pane) =>
      patchPanes(client, pane.conversationId, (panes) => panes.filter((entry) => entry.id !== pane.id)),
  });
}

export function usePanePreview(paneId: string | null) {
  return useQuery({
    queryKey: ['preview', paneId],
    queryFn: () => api<PromptPreview>(`/panes/${paneId}/preview`),
    enabled: Boolean(paneId),
    staleTime: 0,
    gcTime: 0,
  });
}

// Memories

export function useMemories(status?: MemoryStatus) {
  return useQuery({
    queryKey: keys.memories(status),
    queryFn: () => api<Memory[]>(status ? `/memories?status=${status}` : '/memories'),
  });
}

export function usePendingMemoryCount() {
  return useQuery({
    queryKey: keys.pendingCount,
    queryFn: () => api<{ count: number }>('/memories/pending-count'),
    refetchInterval: 20_000,
    select: (data) => data.count,
  });
}

function invalidateMemories(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: ['memories'] });
}

export function useCreateMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (memory: Pick<Memory, 'content' | 'category'>) => api<Memory>('/memories', { method: 'POST', json: memory }),
    onSuccess: () => invalidateMemories(client),
  });
}

export function useUpdateMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: Partial<Memory> & { id: string }) =>
      api<Memory>(`/memories/${id}`, { method: 'PATCH', json: changes }),
    onSuccess: () => invalidateMemories(client),
  });
}

export function useDeleteMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/memories/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateMemories(client),
  });
}
