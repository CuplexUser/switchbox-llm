import { unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
  modified?: Date;
}

/** Formats that are compressed already, so deflating them again only costs time. */
const STORED = /\.(png|jpe?g|gif|webp|avif|zip|gz|tgz|bz2|xz|7z|rar|pdf|mp3|mp4|webm|woff2?|jar|whl|docx|xlsx|pptx)$/i;

export class ArchiveError extends Error {}

/**
 * Streams entries into a ZIP archive, one entry per pull, so a large export is compressed as it is
 * sent rather than built in memory first.
 */
export function zipStream(entries: AsyncIterable<ArchiveEntry>): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull() {
      const next = await iterator.next();
      if (next.done) {
        zip.end();
        return;
      }
      const { path, data, modified } = next.value;
      const file = STORED.test(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
      if (modified) file.mtime = modified;
      zip.add(file);
      file.push(data, true);
    },
    async cancel() {
      zip.terminate();
      await iterator.return?.();
    },
  });
}

/** Whether bytes start like a ZIP archive. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Unpacks an archive into memory, refusing it when an entry or the whole would unpack past the
 * limits, which stops a small file that expands into gigabytes. Folders are left out.
 */
export function unzip(bytes: Uint8Array, limits: { maxEntryBytes: number; maxTotalBytes: number }): Map<string, Uint8Array> {
  let total = 0;
  let unpacked;
  try {
    unpacked = unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        if (file.originalSize > limits.maxEntryBytes) throw new ArchiveError(`"${file.name}" is too large to import.`);
        total += file.originalSize;
        if (total > limits.maxTotalBytes) throw new ArchiveError('The archive unpacks to more than can be imported at once.');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`Not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unpacked)) {
    // The sizes in the headers are the archive's own claim, so the real ones are checked too.
    if (data.byteLength > limits.maxEntryBytes) throw new ArchiveError(`"${name}" is too large to import.`);
    entries.set(name, data);
  }
  return entries;
}
