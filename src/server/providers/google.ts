import { voiceFor } from '../../shared/speech.ts';
import { PROVIDER_LABELS, type GenerationParams, type ModelInfo } from '../../shared/types.ts';
import { pcmToWav } from './audio.ts';
import {
  errorFromResponse,
  joinUrl,
  ProviderError,
  providerFetch,
  speechInput,
  type ChatEvent,
  type ChatRequest,
  type LoopMessage,
  type Provider,
} from './types.ts';

const LABEL = PROVIDER_LABELS.google;

/** Nano Banana and Nano Banana Pro. Google doesn't expose "supports image output" over its model-list
 * API in a way worth parsing, so this mirrors the picker's own "type a model id directly" fallback
 * for anything newer. */
const IMAGE_MODELS: ModelInfo[] = [
  { provider: 'google', model: 'gemini-2.5-flash-image', name: 'Nano Banana (Gemini 2.5 Flash Image)', kind: 'image' },
  { provider: 'google', model: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro (Gemini 3 Pro Image)', kind: 'image' },
  { provider: 'google', model: 'gemini-3.1-flash-image', name: 'Nano Banana Pro (Gemini 3.1 Flash Image)', kind: 'image' },
];

/** Gemini's speech models, served through the Interactions API rather than generateContent. */
const SPEECH_MODELS: ModelInfo[] = [
  { provider: 'google', model: 'gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS', kind: 'speech' },
  { provider: 'google', model: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash Lite TTS', kind: 'speech' },
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

/** `generationConfig.imageConfig`. Null when nothing is set. The size tier is only sent to models
 * newer than Gemini 2.5, which has a single fixed resolution. */
export function googleImageConfig(model: string, params: GenerationParams): Record<string, string> | null {
  const config: Record<string, string> = {};
  if (params.aspectRatio) config.aspectRatio = params.aspectRatio;
  if (params.imageSize && !model.startsWith('gemini-2.')) config.imageSize = params.imageSize;
  return Object.keys(config).length > 0 ? config : null;
}

interface InteractionResponse {
  steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[];
  output_audio?: { data?: string; mime_type?: string };
  error?: { message?: string };
}

/** A script with exactly two speakers, one `Name: line` per line. Null for anything else. */
export function parseDialogue(text: string): { speaker: string; text: string }[] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const turns: { speaker: string; text: string }[] = [];
  for (const line of lines) {
    const match = /^\s*(\p{L}[\p{L} .'-]{0,29}):\s+(\S.*)$/u.exec(line);
    if (!match) return null;
    turns.push({ speaker: (match[1] as string).trim(), text: (match[2] as string).trim() });
  }
  return new Set(turns.map((turn) => turn.speaker)).size === 2 ? turns : null;
}

/** The style note: the chosen style, plus a pace, since Gemini TTS has no numeric speed. */
function geminiStyle(params: GenerationParams): string | null {
  const parts = [params.speechStyle?.trim()];
  if (params.speechSpeed !== null && params.speechSpeed < 0.9) parts.push('speaking slowly');
  if (params.speechSpeed !== null && params.speechSpeed > 1.1) parts.push('speaking quickly');
  const style = parts.filter(Boolean).join(', ');
  return style || null;
}

/**
 * The Interactions API body for Gemini TTS. A script with two named speakers is read as a
 * conversation with a voice each; anything else is one voice. Inline tags such as `<laugh>` pass
 * through untouched.
 */
export function geminiSpeechBody(model: string, input: string, params: GenerationParams): Record<string, unknown> {
  const ref = { provider: 'google' as const, model };
  const style = geminiStyle(params);
  const metadata = (speaker?: string) => {
    const annotation: Record<string, string> = { type: 'speech_metadata' };
    if (speaker) annotation.speaker = speaker;
    if (style) annotation.style = style;
    return Object.keys(annotation).length > 1 ? { annotations: [annotation] } : {};
  };
  const dialogue = parseDialogue(input);
  const first = voiceFor(ref, params.voice) ?? 'Kore';
  if (dialogue) {
    const speakers = [...new Set(dialogue.map((turn) => turn.speaker))];
    const second = voiceFor(ref, params.secondVoice);
    const secondVoice = second && second !== first ? second : first === 'Puck' ? 'Kore' : 'Puck';
    return {
      model,
      input: [{ type: 'user_input', content: dialogue.map((turn) => ({ type: 'text', text: turn.text, ...metadata(turn.speaker) })) }],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: {
          mode: 'conversational',
          speakers: speakers.map((speaker, index) => ({ speaker, voice: index === 0 ? first : secondVoice })),
        },
      },
    };
  }
  return {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text: input, ...metadata() }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: first }] },
  };
}

/** The last audio block of an interaction, as a WAV file. */
export function interactionAudio(data: InteractionResponse): { mimeType: string; data: string } | null {
  const blocks = (data.steps ?? []).flatMap((step) => (step.type === 'model_output' ? (step.content ?? []) : [])).filter((block) => block.type === 'audio' && block.data);
  const block = blocks.at(-1) ?? (data.output_audio?.data ? data.output_audio : null);
  if (!block?.data) return null;
  const mimeType = block.mime_type ?? 'audio/wav';
  // Headerless 16-bit samples are wrapped so a browser can play them.
  if (/l16|pcm/i.test(mimeType)) {
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24_000);
    return { mimeType: 'audio/wav', data: pcmToWav(Buffer.from(block.data, 'base64'), rate).toString('base64') };
  }
  return { mimeType: mimeType.split(';')[0] as string, data: block.data };
}

export interface GoogleOptions {
  baseUrl: string;
  apiKey: string | null;
}

/** Google's Gemini API, called directly for image generation (Nano Banana / Nano Banana Pro) and speech. */
export class GoogleProvider implements Provider {
  readonly id = 'google' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(options: GoogleOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...IMAGE_MODELS, ...SPEECH_MODELS];
  }

  /** Not a real SSE stream: one request, then the whole reply is yielded as a short burst of events. */
  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (!this.apiKey) throw new ProviderError(`${LABEL} needs an API key.`);
    if (!this.baseUrl) throw new ProviderError(`${LABEL} has no base URL configured`);
    if (request.speechOutput) {
      yield* this.speak(request, this.apiKey);
      return;
    }

    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    const imageConfig = googleImageConfig(request.model, request.params);
    if (imageConfig) generationConfig.imageConfig = imageConfig;
    const body: Record<string, unknown> = { contents: toContents(request.messages), generationConfig };
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

  private async *speak(request: ChatRequest, apiKey: string): AsyncIterable<ChatEvent> {
    const input = speechInput(request.messages);
    if (!input) throw new ProviderError('There is no text to read aloud.');
    const response = await providerFetch(LABEL, joinUrl(this.baseUrl, 'interactions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiSpeechBody(request.model, input, request.params)),
      signal: request.signal,
    });
    if (!response.ok) throw await errorFromResponse(LABEL, response);
    const data = (await response.json()) as InteractionResponse;
    if (data.error) throw new ProviderError(data.error.message ?? `${LABEL} reported an error`);
    const audio = interactionAudio(data);
    if (!audio) throw new ProviderError(`${LABEL} returned no audio`);
    yield { type: 'audio', ...audio };
    yield { type: 'finish', reason: 'stop' };
  }
}
