import { appendFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { WorkspaceFile, WorkspaceListing, WorkspaceSettings } from '../../shared/types.ts';

/** A request the workspace refuses, such as a path outside it or a file over the limit. Shown to the model or the user as is. */
export class WorkspaceError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Names Windows reserves in every folder, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Characters Windows refuses in names, plus ":" which would open an alternate data stream. */
// oxlint-disable-next-line no-control-regex
const BAD_CHARACTERS = /[<>:"|?*\x00-\x1f]/;
/** Scratch space for commands (TEMP and TMP point here). Left out of listings, exports and branches. */
export const TEMP_FOLDER = '.tmp';
const MAX_LISTED = 5_000;
const MB = 1024 * 1024;

export interface ReadResult {
  path: string;
  size: number;
  /** Null when the file isn't UTF-8 text. */
  text: string | null;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Whether bytes look like text: no NUL bytes and valid UTF-8. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8_000).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a path a model or the user gave and returns its clean relative form, with forward slashes.
 * Absolute paths, drive letters, "..", characters Windows refuses (":" included, which would reach an
 * alternate data stream) and reserved device names are all refused. An empty path is the workspace itself.
 */
export function cleanPath(path: string): string {
  const unified = path.replaceAll('\\', '/').trim();
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) throw new WorkspaceError(`"${path}" is absolute; use a path inside the workspace.`);
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of segments) {
    if (segment === '..') throw new WorkspaceError(`"${path}" leaves the workspace; ".." is not allowed.`);
    if (BAD_CHARACTERS.test(segment)) throw new WorkspaceError(`"${segment}" contains a character file names can't use.`);
    if (RESERVED_NAME.test(segment)) throw new WorkspaceError(`"${segment}" is a reserved name on Windows.`);
    if (/[. ]$/.test(segment)) throw new WorkspaceError(`"${segment}" ends with a dot or space, which Windows drops.`);
  }
  return segments.join('/');
}

/**
 * Checks a real folder a user wants to bind a chat's workspace to: it must be an absolute path to
 * a folder that already exists, and not a whole drive or the Windows folder. This is a sanity check
 * against the worst mistakes, not a security boundary — run_command can already reach anywhere the
 * user's own account can, at the same trust level as approving a command.
 */
export async function assertBindableRoot(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed)) throw new WorkspaceError(`"${path}" is not an absolute folder path.`);
  const full = resolve(trimmed);
  const info = await stat(full).catch(() => null);
  if (!info) throw new WorkspaceError(`"${path}" does not exist.`);
  if (!info.isDirectory()) throw new WorkspaceError(`"${path}" is not a folder.`);
  const sensitive = [parse(full).root, process.env.WINDIR, process.env.SystemRoot]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value).toLowerCase());
  if (sensitive.includes(full.toLowerCase())) {
    throw new WorkspaceError(`"${path}" is a whole drive or a system folder; pick a folder inside it instead.`);
  }
  return full;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Each chat's files, in `<root>/<conversation id>`. The folder is made on the first write, so a chat
 * that never uses its workspace leaves nothing on disk. Every path goes through `resolve`, which keeps
 * it inside the chat's folder, symbolic links and junctions included.
 */
export class WorkspaceService {
  readonly root: string;
  private readonly limits: () => Promise<WorkspaceSettings>;

  constructor(root: string, limits: () => Promise<WorkspaceSettings>) {
    this.root = resolve(root);
    this.limits = limits;
  }

  /** The folder Switchbox itself owns for this chat. Always safe to delete: never the folder a chat's workspace is bound to. */
  dirFor(conversationId: string): string {
    if (!ID_PATTERN.test(conversationId)) throw new WorkspaceError('Not a valid chat id.');
    return join(this.root, conversationId);
  }

  /** The folder a chat's workspace actually reads and writes: its bound folder if it has one, otherwise its owned folder. */
  private effectiveDir(conversationId: string, hostFolderPath: string | null): string {
    return hostFolderPath ? resolve(hostFolderPath) : this.dirFor(conversationId);
  }

  async exists(conversationId: string, hostFolderPath: string | null = null): Promise<boolean> {
    return exists(this.effectiveDir(conversationId, hostFolderPath));
  }

  /** Makes the folder and its scratch folder, and returns the folder. */
  async ensure(conversationId: string, hostFolderPath: string | null = null): Promise<string> {
    const dir = this.effectiveDir(conversationId, hostFolderPath);
    await mkdir(join(dir, TEMP_FOLDER), { recursive: true });
    return dir;
  }

  /** The absolute path for a relative one, after checking it stays inside the chat's folder. */
  async resolve(
    conversationId: string,
    path: string,
    options: { allowRoot?: boolean } = {},
    hostFolderPath: string | null = null,
  ): Promise<{ full: string; path: string }> {
    const clean = cleanPath(path);
    if (!clean && !options.allowRoot) throw new WorkspaceError('A file path is required.');
    const dir = this.effectiveDir(conversationId, hostFolderPath);
    const full = clean ? join(dir, ...clean.split('/')) : dir;
    if (!within(dir, full)) throw new WorkspaceError(`"${path}" leaves the workspace.`);
    // A link inside the folder could point anywhere, so the nearest part that exists must resolve inside it.
    if (await exists(dir)) {
      const realDir = await realpath(dir);
      let probe = full;
      while (probe !== dir && !(await exists(probe))) probe = dirname(probe);
      const real = await realpath(probe).catch(() => null);
      if (real === null || !within(realDir, real)) throw new WorkspaceError(`"${path}" points outside the workspace.`);
    }
    return { full, path: clean };
  }

  private async walk(dir: string, base: string, into: WorkspaceFile[], includeTemp: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (into.length >= MAX_LISTED) return;
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (!includeTemp && path === TEMP_FOLDER) continue;
      // Links are never followed, so a link can't pull outside files into a listing or an export.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, path, into, includeTemp);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (info) into.push({ path, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  }

  /** Files under `folder` (the whole workspace by default), without the scratch folder. */
  async files(conversationId: string, folder = '', hostFolderPath: string | null = null): Promise<WorkspaceFile[]> {
    const { full, path } = await this.resolve(conversationId, folder, { allowRoot: true }, hostFolderPath);
    const files: WorkspaceFile[] = [];
    await this.walk(full, path, files, false);
    return files;
  }

  /** Bytes used by the whole folder, scratch files included. */
  async usage(conversationId: string, hostFolderPath: string | null = null): Promise<number> {
    const files: WorkspaceFile[] = [];
    await this.walk(this.effectiveDir(conversationId, hostFolderPath), '', files, true);
    return files.reduce((total, file) => total + file.size, 0);
  }

  async quota(): Promise<number> {
    return (await this.limits()).quotaMb * MB;
  }

  async listing(conversationId: string, hostFolderPath: string | null = null): Promise<WorkspaceListing> {
    const present = await this.exists(conversationId, hostFolderPath);
    return {
      files: present ? await this.files(conversationId, '', hostFolderPath) : [],
      usage: present ? await this.usage(conversationId, hostFolderPath) : 0,
      quota: await this.quota(),
      exists: present,
    };
  }

  async readBytes(conversationId: string, path: string, hostFolderPath: string | null = null): Promise<{ path: string; data: Buffer }> {
    const target = await this.resolve(conversationId, path, {}, hostFolderPath);
    const info = await stat(target.full).catch(() => null);
    if (!info) throw new WorkspaceError(`There is no file "${target.path}".`);
    if (info.isDirectory()) throw new WorkspaceError(`"${target.path}" is a folder.`);
    return { path: target.path, data: await readFile(target.full) };
  }

  async read(conversationId: string, path: string, hostFolderPath: string | null = null): Promise<ReadResult> {
    const { path: clean, data } = await this.readBytes(conversationId, path, hostFolderPath);
    return { path: clean, size: data.byteLength, text: isText(data) ? data.toString('utf8') : null };
  }

  /**
   * Writes or appends, checking the size limits first. `overwrite: false` leaves an existing file alone
   * and returns false, which imports use.
   */
  async write(
    conversationId: string,
    path: string,
    content: string | Uint8Array,
    options: { append?: boolean; overwrite?: boolean } = {},
    hostFolderPath: string | null = null,
  ): Promise<{ path: string; bytes: number; created: boolean; written: boolean }> {
    const target = await this.resolve(conversationId, path, {}, hostFolderPath);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const limits = await this.limits();
    const existing = await stat(target.full).catch(() => null);
    if (existing?.isDirectory()) throw new WorkspaceError(`"${target.path}" is a folder.`);
    if (existing && options.overwrite === false) return { path: target.path, bytes: existing.size, created: false, written: false };

    const finalSize = options.append ? (existing?.size ?? 0) + bytes.byteLength : bytes.byteLength;
    if (finalSize > limits.maxFileMb * MB) {
      throw new WorkspaceError(`"${target.path}" would be ${(finalSize / MB).toFixed(1)} MB; files are limited to ${limits.maxFileMb} MB.`);
    }
    // A bound folder is the user's own disk, not chat storage counted against a quota.
    if (!hostFolderPath) {
      const used = (await this.exists(conversationId)) ? await this.usage(conversationId) : 0;
      const after = used - (existing?.size ?? 0) + finalSize;
      if (after > limits.quotaMb * MB) {
        throw new WorkspaceError(
          `The workspace would hold ${(after / MB).toFixed(1)} MB, over its ${limits.quotaMb} MB limit. Delete files that are no longer needed first.`,
        );
      }
    }

    await this.ensure(conversationId, hostFolderPath);
    await mkdir(dirname(target.full), { recursive: true });
    if (options.append) await appendFile(target.full, bytes);
    else await writeFile(target.full, bytes);
    return { path: target.path, bytes: finalSize, created: !existing, written: true };
  }

  /** Replaces exact text. Refuses when the text is missing, or appears more than once without `replaceAll`. */
  async edit(
    conversationId: string,
    path: string,
    oldText: string,
    newText: string,
    replaceAll = false,
    hostFolderPath: string | null = null,
  ): Promise<{ path: string; replacements: number }> {
    if (!oldText) throw new WorkspaceError('old_text must not be empty.');
    const file = await this.read(conversationId, path, hostFolderPath);
    if (file.text === null) throw new WorkspaceError(`"${file.path}" is not a text file.`);
    const count = file.text.split(oldText).length - 1;
    if (count === 0) throw new WorkspaceError(`The text to replace was not found in "${file.path}". Read the file again and copy the text exactly.`);
    if (count > 1 && !replaceAll) {
      throw new WorkspaceError(`The text appears ${count} times in "${file.path}". Include more surrounding lines, or set replace_all.`);
    }
    const updated = replaceAll ? file.text.replaceAll(oldText, () => newText) : file.text.replace(oldText, () => newText);
    await this.write(conversationId, file.path, updated, {}, hostFolderPath);
    return { path: file.path, replacements: replaceAll ? count : 1 };
  }

  /** Deletes a file or a folder with everything in it. */
  async remove(conversationId: string, path: string, hostFolderPath: string | null = null): Promise<{ path: string; folder: boolean }> {
    const target = await this.resolve(conversationId, path, {}, hostFolderPath);
    const info = await lstat(target.full).catch(() => null);
    if (!info) throw new WorkspaceError(`There is no file or folder "${target.path}".`);
    await rm(target.full, { recursive: true, force: true });
    return { path: target.path, folder: info.isDirectory() };
  }

  /** Empties a chat's workspace of its contents without removing the folder itself — safe for a bound folder too. */
  async clear(conversationId: string, hostFolderPath: string | null = null): Promise<void> {
    const dir = this.effectiveDir(conversationId, hostFolderPath);
    if (!(await exists(dir))) return;
    const entries = await readdir(dir);
    await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
  }

  async move(conversationId: string, from: string, to: string, hostFolderPath: string | null = null): Promise<{ from: string; to: string }> {
    const source = await this.resolve(conversationId, from, {}, hostFolderPath);
    const destination = await this.resolve(conversationId, to, {}, hostFolderPath);
    if (!(await exists(source.full))) throw new WorkspaceError(`There is no file or folder "${source.path}".`);
    if (await exists(destination.full)) throw new WorkspaceError(`"${destination.path}" already exists.`);
    if (within(source.full, destination.full)) throw new WorkspaceError('A folder cannot be moved into itself.');
    await mkdir(dirname(destination.full), { recursive: true });
    await rename(source.full, destination.full);
    return { from: source.path, to: destination.path };
  }

  /** Lines containing `query`, ignoring case, in text files under `folder`. */
  async search(
    conversationId: string,
    query: string,
    folder = '',
    limit = 100,
    hostFolderPath: string | null = null,
  ): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];
    for (const file of await this.files(conversationId, folder, hostFolderPath)) {
      if (file.size > 2 * MB) continue;
      const { data } = await this.readBytes(conversationId, file.path, hostFolderPath);
      if (!isText(data)) continue;
      const lines = data.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= limit) return { matches, truncated: true };
        matches.push({ path: file.path, line: index + 1, text: line.length > 300 ? `${line.slice(0, 299)}…` : line });
      }
    }
    return { matches, truncated: false };
  }

  /** Size and modified time of every file, for telling what a command changed. */
  async snapshot(conversationId: string, hostFolderPath: string | null = null): Promise<Map<string, string>> {
    const files = (await this.exists(conversationId, hostFolderPath)) ? await this.files(conversationId, '', hostFolderPath) : [];
    return new Map(files.map((file) => [file.path, `${file.size}:${file.modifiedAt}`]));
  }

  /** Gives a branch its own copy of the files. */
  async copy(fromId: string, toId: string): Promise<void> {
    const source = this.dirFor(fromId);
    if (!(await exists(source))) return;
    const target = this.dirFor(toId);
    await cp(source, target, {
      recursive: true,
      errorOnExist: false,
      filter: async (path) => {
        const info = await lstat(path);
        return !info.isSymbolicLink() && relative(source, path).split(sep)[0] !== TEMP_FOLDER;
      },
    });
    await mkdir(join(target, TEMP_FOLDER), { recursive: true });
  }

  async deleteFor(conversationId: string): Promise<void> {
    await rm(this.dirFor(conversationId), { recursive: true, force: true });
  }

  /** Folders for chats that no longer exist, or every folder when `keep` is empty. Only folders named like chat ids are touched. */
  async prune(keep: Set<string>): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name) || keep.has(entry.name)) continue;
      await rm(join(this.root, entry.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  async deleteAll(): Promise<number> {
    return this.prune(new Set());
  }
}
