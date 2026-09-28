import type * as Mediabunny from 'mediabunny';

/** Formats a spoken reply can be saved as. All are encoded in the browser. */
export type AudioSaveFormat = 'mp3' | 'aac' | 'ac3' | 'wav';

export interface AudioSaveOption {
  format: AudioSaveFormat;
  label: string;
  extension: string;
  mimeType: string;
  note: string;
}

export const AUDIO_SAVE_OPTIONS: AudioSaveOption[] = [
  { format: 'mp3', label: 'MP3', extension: 'mp3', mimeType: 'audio/mpeg', note: 'Plays anywhere' },
  { format: 'aac', label: 'AAC', extension: 'm4a', mimeType: 'audio/mp4', note: 'Smaller at the same quality, .m4a' },
  { format: 'ac3', label: 'AC-3', extension: 'ac3', mimeType: 'audio/ac3', note: 'Dolby Digital, 48 kHz' },
  { format: 'wav', label: 'WAV', extension: 'wav', mimeType: 'audio/wav', note: 'Uncompressed' },
];

/** The save format a file already is, so the menu can leave it out. */
export function audioSaveFormatOf(mimeType: string): AudioSaveFormat | null {
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/wav') return 'wav';
  if (mimeType === 'audio/ac3') return 'ac3';
  return null;
}

/** Samples as a 16-bit PCM WAV file, channels interleaved. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const samples of data) {
      const sample = Math.max(-1, Math.min(1, samples[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

async function decodeAudio(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load the audio (${response.status})`);
  const bytes = await response.arrayBuffer();
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(bytes);
  } catch {
    throw new Error("This browser can't read this audio");
  } finally {
    void context.close();
  }
}

/**
 * Bits per second for each channel. Speech is almost always mono, where these sound clean; the
 * encoders' own "high" presets aim at music and came out at three to six times the size.
 */
const BITRATE_PER_CHANNEL: Record<Exclude<AudioSaveFormat, 'wav'>, number> = { mp3: 96_000, aac: 96_000, ac3: 96_000 };

/** How long an encode may take at least; longer clips get as long as they play. */
const ENCODE_TIMEOUT_MS = 30_000;

/** Encoders registered with Mediabunny so far; each registers once per page. */
const registered = new Set<AudioSaveFormat>();

/**
 * Mediabunny and its WASM encoders are loaded on first use, so they cost nothing until someone
 * saves audio. AAC uses the browser's own encoder when it has one, else the WASM one.
 */
async function loadEncoder(format: AudioSaveFormat): Promise<typeof Mediabunny> {
  const mediabunny = await import('mediabunny');
  if (registered.has(format)) return mediabunny;
  if (format === 'mp3') (await import('@mediabunny/mp3-encoder')).registerMp3Encoder();
  if (format === 'ac3') (await import('@mediabunny/ac3')).registerAc3Encoder();
  if (format === 'aac' && !(await mediabunny.canEncodeAudio('aac', { numberOfChannels: 1, sampleRate: 48_000 }))) {
    (await import('@mediabunny/aac-encoder')).registerAacEncoder();
  }
  registered.add(format);
  return mediabunny;
}

/**
 * Re-encodes audio in the browser. The source is decoded by the browser, then encoded with
 * Mediabunny. AC-3 is only defined for 32, 44.1 and 48 kHz, so it is resampled to 48 kHz; its
 * frames are self-contained, so a plain .ac3 file is just the encoded frames in order.
 */
export async function convertAudio(url: string, format: AudioSaveFormat): Promise<Blob> {
  const decoded = await decodeAudio(url);
  if (format === 'wav') return encodeWav(decoded);

  const option = AUDIO_SAVE_OPTIONS.find((entry) => entry.format === format) as AudioSaveOption;
  const mediabunny = await loadEncoder(format);
  const target = new mediabunny.BufferTarget();
  const outputFormat =
    format === 'mp3'
      ? new mediabunny.Mp3OutputFormat()
      : format === 'aac'
        ? new mediabunny.Mp4OutputFormat({ fastStart: 'in-memory' })
        : new mediabunny.MkvOutputFormat();
  const output = new mediabunny.Output({ format: outputFormat, target });
  const frames: Uint8Array[] = [];
  const source = new mediabunny.AudioBufferSource({
    codec: format,
    quality: new mediabunny.Quality({ bitrate: BITRATE_PER_CHANNEL[format] * Math.min(decoded.numberOfChannels, 2) }),
    ...(format === 'ac3' ? { transform: { sampleRate: 48_000 }, onEncodedPacket: (packet) => frames.push(packet.data.slice()) } : {}),
  });
  output.addAudioTrack(source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A WASM encoder given settings it can't handle may wait forever instead of failing.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('it took too long')), Math.max(ENCODE_TIMEOUT_MS, decoded.duration * 1000));
  });
  try {
    await Promise.race([
      (async () => {
        await output.start();
        await source.add(decoded);
        source.close();
        await output.finalize();
      })(),
      timeout,
    ]);
  } catch (error) {
    await output.cancel().catch(() => {});
    throw new Error(`Couldn't encode ${option.label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (format === 'ac3') return new Blob(frames as BlobPart[], { type: option.mimeType });
  if (!target.buffer) throw new Error(`Couldn't encode ${option.label}`);
  return new Blob([target.buffer], { type: option.mimeType });
}
