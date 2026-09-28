import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Attachment, AttachmentKind, AttachmentRef } from '../../shared/types.ts';
import type { Repos } from '../db/repos.ts';
import type { AttachmentRow } from '../db/schemas.ts';
import type { LoopAttachment } from '../providers/types.ts';
import { serialize } from './serialize.ts';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Text files longer than this are cut in the prompt; the model can read the rest with read_attachment. */
export const INLINE_TEXT_CHARS = 30_000;

const IMAGE_SIGNATURES: [string, number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46]],
];

/** Formats a speech model can return. Checked after the image signatures, since WAV and WebP are both RIFF. */
export function audioType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  // A bare MPEG frame sync: 11 set bits. Layer bits 01 are MP3; 00 is an AAC ADTS header.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return ((bytes[1] ?? 0) & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  return null;
}

const TEXT_EXTENSIONS = new Set(
  '.txt .md .markdown .csv .tsv .json .jsonl .xml .yaml .yml .toml .ini .cfg .conf .log .html .htm .css .scss .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .kt .swift .c .h .cpp .hpp .cc .cs .php .sql .sh .bash .zsh .ps1 .bat .lua .r .m .scala .dart .vue .svelte .graphql .proto .env .gitignore .dockerfile .tex .rst .srt .vtt'.split(
    ' ',
  ),
);

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Works out what kind of file this is from its bytes first, then its type and name. Null when it isn't supported. */
export function classify(name: string, mimeType: string, bytes: Uint8Array): { kind: AttachmentKind; mimeType: string } | null {
  for (const [type, signature] of IMAGE_SIGNATURES) {
    if (startsWith(bytes, signature)) {
      // RIFF is shared by other formats; WebP says so at offset 8.
      if (type === 'image/webp' && new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP') continue;
      return { kind: 'image', mimeType: type };
    }
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mimeType: 'application/pdf' };
  const audio = audioType(bytes);
  if (audio) return { kind: 'audio', mimeType: audio };

  const textual = mimeType.startsWith('text/') || /json|xml|yaml|javascript|typescript|x-sh|csv|markdown|toml|sql/.test(mimeType) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
  if (!textual) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Always served as plain text, so an uploaded HTML or SVG file can never render as a page.
  return { kind: 'text', mimeType: 'text/plain' };
}

export function toRef(row: Pick<AttachmentRow, 'id' | 'name' | 'mimeType' | 'size' | 'kind'>): AttachmentRef {
  return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, kind: row.kind as AttachmentKind };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
};

/** A filename extension for a generated image or speech, from the mime type the provider reported. */
export function extFromMime(mimeType: string): string {
  const type = mimeType.toLowerCase().split(';')[0] ?? '';
  return EXTENSION_BY_MIME[type] ?? (type.startsWith('audio/') ? 'mp3' : 'png');
}

export function toAttachment(row: AttachmentRow): Attachment {
  const { data: _data, ...rest } = row;
  return serialize<Attachment>(rest);
}

export function decodeText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export class AttachmentError extends Error {}

export class AttachmentService {
  private readonly repos: Repos;

  constructor(repos: Repos) {
    this.repos = repos;
  }

  /** `generated` is set for a model's own output; uploads can't be audio, since no model is sent audio. */
  async create(input: { name: string; mimeType: string; data: string; conversationId?: string | null; generated?: boolean }): Promise<Attachment> {
    const name = input.name.trim().slice(0, 200) || 'file';
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.byteLength === 0) throw new AttachmentError(`${name} is empty.`);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    }
    const kind = classify(name, input.mimeType.toLowerCase(), bytes);
    if (!kind || (kind.kind === 'audio' && !input.generated)) {
      throw new AttachmentError(`${name} isn't a supported file. Attach images (PNG, JPEG, GIF, WebP), PDFs, or text and code files.`);
    }
    const row = await this.repos.attachments.create({
      id: randomUUID(),
      conversationId: input.conversationId ?? null,
      name,
      mimeType: kind.mimeType,
      size: bytes.byteLength,
      kind: kind.kind,
      data: bytes,
    });
    return toAttachment(row);
  }

  async get(id: string): Promise<AttachmentRow | null> {
    return this.repos.attachments.findById(id);
  }

  /**
   * Checks that every id exists and belongs to this chat or to no chat yet, then assigns the
   * unassigned ones to it. Returns the refs in the order given.
   */
  async claim(ids: string[], conversationId: string): Promise<AttachmentRef[]> {
    const refs: AttachmentRef[] = [];
    for (const id of new Set(ids)) {
      const row = await this.repos.attachments.findById(id);
      if (!row || (row.conversationId !== null && row.conversationId !== conversationId)) {
        throw new AttachmentError('An attachment could not be found. Attach the file again.');
      }
      if (row.conversationId === null) await this.repos.attachments.update(id, { conversationId });
      refs.push(toRef(row));
    }
    return refs;
  }

  /** File contents ready for a provider: base64 for images and PDFs, text for text files. Audio is left out. */
  async load(refs: AttachmentRef[]): Promise<LoopAttachment[]> {
    const loaded: LoopAttachment[] = [];
    for (const ref of refs) {
      const row = await this.repos.attachments.findById(ref.id);
      if (!row || row.kind === 'audio') continue;
      if (row.kind === 'text') {
        const text = decodeText(row.data);
        const cut = text.length > INLINE_TEXT_CHARS;
        loaded.push({
          id: row.id,
          name: row.name,
          mimeType: row.mimeType,
          kind: 'text',
          text: cut
            ? `${text.slice(0, INLINE_TEXT_CHARS)}\n[Only the first ${INLINE_TEXT_CHARS} of ${text.length} characters are shown. Read the rest with read_attachment using id "${row.id}".]`
            : text,
        });
      } else {
        loaded.push({
          id: row.id,
          name: row.name,
          mimeType: row.mimeType,
          kind: row.kind as 'image' | 'pdf',
          data: Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength).toString('base64'),
        });
      }
    }
    return loaded;
  }

  async deleteForConversation(conversationId: string): Promise<number> {
    return this.repos.attachments.deleteMany({ where: { conversationId } });
  }

  /** Uploads never sent with a message, e.g. from a new chat that was abandoned. */
  async deleteUnclaimed(olderThan: Date): Promise<number> {
    return this.repos.attachments.deleteMany({
      where: [
        { field: 'conversationId', op: 'isNull', value: true },
        { field: 'createdAt', op: 'lt', value: olderThan },
      ],
    });
  }
}
