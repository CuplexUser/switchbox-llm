/** Base64 of a file's bytes, built in chunks so large files don't overflow the call stack. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}/content`;
}

/** Saves text as a file through a temporary link. */
export function downloadText(filename: string, text: string, type: string): void {
  downloadBlob(filename, new Blob([text], { type }));
}

/** Saves a blob as a file through a temporary link. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export const IMAGE_FORMAT_LABELS: Record<ImageFormat, string> = { png: 'PNG', jpeg: 'JPG', webp: 'WebP' };
const FORMAT_EXTENSIONS: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/**
 * Re-encodes an image in the browser. JPG has no transparency, so it is drawn over white rather
 * than letting transparent pixels turn black.
 */
export async function convertImage(url: string, format: ImageFormat, quality = 0.92): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load the image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot convert images');
  if (format === 'jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${format}`, quality));
  // Browsers fall back to PNG for a type they can't write, so check what actually came out.
  if (!blob || blob.type !== `image/${format}`) throw new Error(`This browser cannot save ${IMAGE_FORMAT_LABELS[format]} images`);
  return blob;
}

/** `name` with its extension swapped for the format's. */
export function renameForFormat(name: string, format: ImageFormat): string {
  return withExtension(name, FORMAT_EXTENSIONS[format]);
}

export function withExtension(name: string, extension: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'file';
  return `${base}.${extension}`;
}

/** Short names for the audio types speech models return. */
export function audioLabel(mimeType: string): string {
  const labels: Record<string, string> = { 'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/ogg': 'Ogg', 'audio/aac': 'AAC', 'audio/flac': 'FLAC', 'audio/mp4': 'M4A' };
  return labels[mimeType] ?? mimeType.replace('audio/', '').toUpperCase();
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

/** Decodes audio in the browser and writes it out as WAV, which every editor and player opens. */
export async function convertAudioToWav(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load the audio (${response.status})`);
  const context = new AudioContext();
  try {
    return encodeWav(await context.decodeAudioData(await response.arrayBuffer()));
  } catch {
    throw new Error('This browser cannot convert this audio');
  } finally {
    void context.close();
  }
}
