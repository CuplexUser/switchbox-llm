/** Raw 16-bit PCM as a playable WAV file. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** Rate and channels from a content type such as `audio/pcm;rate=24000;channels=1`. */
export function pcmFormat(contentType: string | null): { sampleRate: number; channels: number } {
  const rate = /rate=(\d+)/i.exec(contentType ?? '')?.[1];
  const channels = /channels=(\d+)/i.exec(contentType ?? '')?.[1];
  return { sampleRate: rate ? Number(rate) : 24_000, channels: channels ? Number(channels) : 1 };
}

interface WavParts {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/** The format and samples of a PCM WAV file, walking its chunks. Null for anything else. */
export function readWav(bytes: Buffer): WavParts | null {
  if (bytes.byteLength < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format: Omit<WavParts, 'pcm'> | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      if (bytes.readUInt16LE(start) !== 1) return null;
      format = { channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bitsPerSample: bytes.readUInt16LE(start + 14) };
    } else if (id === 'data' && format) {
      // Streamed WAVs sometimes leave the size as a placeholder; take what's there.
      return { ...format, pcm: bytes.subarray(start, Math.min(start + size, bytes.byteLength)) };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

/**
 * One file from several pieces of speech in the same format. WAVs are rejoined at the sample level;
 * MP3 files are streams of independent frames, so their bytes simply follow each other.
 */
export function joinAudio(parts: { mimeType: string; data: Buffer }[]): { mimeType: string; data: Buffer } {
  const first = parts[0];
  if (!first) throw new Error('No audio to join');
  if (parts.length === 1) return first;
  if (first.mimeType === 'audio/wav') {
    const wavs = parts.map((part) => readWav(part.data));
    const head = wavs[0];
    if (head && head.bitsPerSample === 16 && wavs.every((wav) => wav && wav.sampleRate === head.sampleRate && wav.channels === head.channels)) {
      return { mimeType: 'audio/wav', data: pcmToWav(Buffer.concat(wavs.map((wav) => (wav as WavParts).pcm)), head.sampleRate, head.channels) };
    }
  }
  return { mimeType: first.mimeType, data: Buffer.concat(parts.map((part) => part.data)) };
}
