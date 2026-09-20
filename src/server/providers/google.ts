import { PROVIDER_LABELS, type ModelInfo } from '../../shared/types.ts';
import { errorFromResponse, joinUrl, ProviderError, providerFetch, type ChatEvent, type ChatRequest, type LoopMessage, type Provider } from './types.ts';

const LABEL = PROVIDER_LABELS.google;

/** Nano Banana and Nano Banana Pro. Google doesn't expose "supports image output" over its model-list
 * API in a way worth parsing, so this mirrors the picker's own "type a model id directly" fallback
 * for anything newer. */
const IMAGE_MODELS: ModelInfo[] = [
  { provider: 'google', model: 'gemini-2.5-flash-image', name: 'Nano Banana (Gemini 2.5 Flash Image)', kind: 'image' },
  { provider: 'google', model: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro (Gemini 3 Pro Image)', kind: 'image' },
  { provider: 'google', model: 'gemini-3.1-flash-image', name: 'Nano Banana Pro (Gemini 3.1 Flash Image)', kind: 'image' },
];

interface GooglePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

/** Text and user-attached images become `contents`; assistant text becomes the 'model' role. Tool
 * turns never happen here, since image panes don't offer tools. */
function toContents(messages: LoopMessage[]): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    const parts: Record<string, unknown>[] = [];
    if (message.role === 'user') {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === 'image' && attachment.data) {
          parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
        }
      }
    }
    if (message.content) parts.push({ text: message.content });
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

export interface GoogleOptions {
  baseUrl: string;
  apiKey: string | null;
}

/** Google's Gemini API, called directly for image generation (Nano Banana / Nano Banana Pro). */
export class GoogleProvider implements Provider {
  readonly id = 'google' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(options: GoogleOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    return IMAGE_MODELS;
  }

  /** Not a real SSE stream: one request, then the whole reply is yielded as a short burst of events. */
  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (!this.apiKey) throw new ProviderError(`${LABEL} needs an API key.`);
    if (!this.baseUrl) throw new ProviderError(`${LABEL} has no base URL configured`);

    const body: Record<string, unknown> = {
      contents: toContents(request.messages),
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

    const url = joinUrl(this.baseUrl, `models/${request.model}:generateContent`);
    const response = await providerFetch(LABEL, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse(LABEL, response);
    const data = (await response.json()) as GenerateContentResponse;
    if (data.error) throw new ProviderError(data.error.message ?? `${LABEL} reported an error`);

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        yield { type: 'image', mimeType: part.inlineData.mimeType || 'image/png', data: part.inlineData.data };
      } else if (part.text) {
        yield { type: 'text', text: part.text };
      }
    }
    if (data.usageMetadata) {
      yield { type: 'usage', inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount };
    }
    yield { type: 'finish', reason: data.candidates?.[0]?.finishReason ?? 'stop' };
  }
}
