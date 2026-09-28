import type { AudioFormat, ModelRef } from './types.ts';

/** Who makes a speech model, which decides its voices and options. OpenRouter ids carry it as a prefix. */
export type SpeechFamily = 'openai' | 'google' | 'xai' | 'mistral' | 'microsoft';

const OPENROUTER_FAMILIES: Record<string, SpeechFamily> = {
  openai: 'openai',
  google: 'google',
  'x-ai': 'xai',
  mistralai: 'mistral',
  microsoft: 'microsoft',
};

export function speechFamily(ref: ModelRef): SpeechFamily | null {
  if (ref.provider === 'openai') return 'openai';
  if (ref.provider === 'google') return 'google';
  if (ref.provider === 'openrouter') return OPENROUTER_FAMILIES[ref.model.split('/')[0] ?? ''] ?? null;
  return null;
}

/** Gemini TTS's 30 prebuilt voices. */
export const GEMINI_VOICES = [
  'Kore',
  'Puck',
  'Zephyr',
  'Charon',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];

/** Known voices per family, the first being the default. Others can still be typed in. */
export const SPEECH_VOICES: Record<SpeechFamily, string[]> = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
  google: GEMINI_VOICES,
  xai: ['eve', 'ara', 'rex', 'sal', 'leo'],
  mistral: ['en_paul_neutral'],
  microsoft: ['en-US-Harper:MAI-Voice-2'],
};

export function speechVoices(ref: ModelRef): string[] {
  const family = speechFamily(ref);
  return family ? SPEECH_VOICES[family] : [];
}

/**
 * The voice to send: the chosen one when it suits this model, else the model's default. A voice
 * picked for one family (say "alloy" in Settings) would be rejected by another (Gemini), so a known
 * voice from a different family falls back rather than failing the request. Unknown names pass
 * through, since providers add voices faster than this list does.
 */
export function voiceFor(ref: ModelRef, chosen: string | null): string | null {
  const own = speechVoices(ref);
  const wanted = chosen?.trim();
  if (wanted) {
    const lower = wanted.toLowerCase();
    const match = own.find((voice) => voice.toLowerCase() === lower);
    if (match) return match;
    const elsewhere = Object.values(SPEECH_VOICES).some((voices) => voices.some((voice) => voice.toLowerCase() === lower));
    if (!elsewhere) return wanted;
  }
  return own[0] ?? null;
}

/** Formats a speech route can return. Anything else is asked for as the first one. */
export function speechFormats(ref: ModelRef): AudioFormat[] {
  if (ref.provider === 'google') return ['wav'];
  if (ref.provider === 'openrouter') return ['mp3', 'wav'];
  return ['mp3', 'wav', 'opus', 'aac', 'flac'];
}

export const AUDIO_MIME_TYPES: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};
