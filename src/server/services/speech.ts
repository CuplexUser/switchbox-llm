import { isSpeechModel, mergeParams } from '../../shared/defaults.ts';
import type { ModelRef } from '../../shared/types.ts';
import { joinAudio } from '../providers/audio.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError } from '../providers/types.ts';
import { mapLimit } from './chat.ts';
import type { SettingsService } from './settings.ts';

/** OpenAI's speech endpoint takes at most 4,096 characters, so longer replies go in pieces. */
export const SPEECH_CHUNK_CHARS = 4_000;
/** The most of one reply that is read; the rest is left out rather than billed. */
export const MAX_READ_CHARS = 40_000;

/**
 * Markdown as it would be read out: code blocks and tables are named rather than spelled out,
 * links keep their text, and formatting marks are dropped.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '\n(Code block omitted.)\n')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[ \t]*\|.*\|[ \t]*$(\r?\n^[ \t]*\|.*\|[ \t]*$)*/gm, '\n(Table omitted.)\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits text into pieces of at most `limit` characters, at paragraph, then sentence, then word breaks. */
export function splitForSpeech(text: string, limit = SPEECH_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = (part: string, joiner: string) => {
    if (!current) current = part;
    else if (current.length + joiner.length + part.length <= limit) current += joiner + part;
    else {
      pieces.push(current);
      current = part;
    }
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length <= limit) {
      push(paragraph, '\n\n');
      continue;
    }
    for (const sentence of paragraph.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [paragraph]) {
      let rest = sentence.trim();
      while (rest.length > limit) {
        const cut = rest.lastIndexOf(' ', limit) > limit / 2 ? rest.lastIndexOf(' ', limit) : limit;
        push(rest.slice(0, cut), ' ');
        rest = rest.slice(cut).trim();
      }
      if (rest) push(rest, ' ');
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Reads replies aloud with the speech model chosen in Settings → General. */
export class SpeechService {
  private readonly settings: SettingsService;
  private readonly providers: ProviderRegistry;

  constructor(settings: SettingsService, providers: ProviderRegistry) {
    this.settings = settings;
    this.providers = providers;
  }

  async model(): Promise<ModelRef | null> {
    return (await this.settings.get('general')).speechModel;
  }

  /** One audio file for the whole text. Long text is spoken in pieces and joined. */
  async readAloud(markdown: string, signal: AbortSignal): Promise<{ mimeType: string; data: Buffer }> {
    const ref = await this.model();
    if (!ref) throw new ProviderError('Choose a speech model in Settings → General to read replies aloud.');
    const text = speakableText(markdown).slice(0, MAX_READ_CHARS);
    if (!text) throw new ProviderError('There is no text to read aloud.');
    const provider = await this.providers.get(ref.provider);
    const listed = await this.providers.models(ref.provider).catch(() => this.providers.cachedModels(ref.provider));
    if (!isSpeechModel(ref, listed.find((model) => model.model === ref.model))) {
      throw new ProviderError(`${ref.model} isn't a speech model. Choose one in Settings → General.`);
    }
    // Pieces are joined, and MP3 and WAV are the formats that join cleanly.
    const generation = await this.settings.get('generation');
    const params = mergeParams(generation, { audioFormat: generation.audioFormat === 'wav' ? 'wav' : 'mp3' });

    const parts = await mapLimit(splitForSpeech(text), 3, async (piece) => {
      for await (const event of provider.streamChat({
        model: ref.model,
        system: '',
        messages: [{ role: 'user', content: piece }],
        params,
        signal,
        speechOutput: true,
      })) {
        if (event.type === 'audio') return { mimeType: event.mimeType, data: Buffer.from(event.data, 'base64') };
      }
      throw new ProviderError(`${ref.model} returned no audio. Is it a speech model?`);
    });
    return joinAudio(parts);
  }
}
