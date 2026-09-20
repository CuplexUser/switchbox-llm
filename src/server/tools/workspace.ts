import { join } from 'node:path';
import type { AppSettings, WorkspaceFile, WorkspaceSettings } from '../../shared/types.ts';
import { detectToolchains, platformName, runCommand, shellName, type CommandOptions } from '../services/commands.ts';
import { bwrapAvailable, detectSandboxToolchains } from '../services/sandbox.ts';
import { TEMP_FOLDER, WorkspaceError, type WorkspaceService } from '../services/workspaces.ts';
import { errorText, type ToolDefinition, type ToolGroup, type ToolResult, type ToolSource } from './types.ts';

export const FILES_GROUP: ToolGroup = {
  id: 'files',
  label: 'Workspace files',
  description: 'Create, read, edit and delete files in the chat’s own workspace folder.',
  kind: 'builtin',
  onByDefault: true,
  toggledBy: 'workspace',
};

export const COMMANDS_GROUP: ToolGroup = {
  id: 'commands',
  label: 'Run commands',
  description:
    'Compile and run code with the programs installed on this computer, inside the chat’s workspace folder. ' +
    'Commands are not isolated from the rest of the computer, so each one asks first unless you change that.',
  kind: 'builtin',
  onByDefault: false,
  toggledBy: null,
  requires: 'workspace',
};

const READ_DEFAULT_LINES = 400;
const READ_MAX_CHARS = 50_000;
const LISTED_IN_PROMPT = 50;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ok(content: string): ToolResult {
  return { content, isError: false };
}

/** Workspace refusals go back to the model as plain errors; anything else is unexpected and says so. */
async function guarded(task: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await task();
  } catch (error) {
    return { content: error instanceof WorkspaceError ? `Error: ${error.message}` : `Error: ${errorText(error)}`, isError: true };
  }
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Told to the model when the file tools are offered, with the files already there. */
export function workspaceGuidance(files: WorkspaceFile[], commands: boolean, hostFolderPath: string | null = null): string {
  const listed = files.slice(0, LISTED_IN_PROMPT).map((file) => `- ${file.path} (${size(file.size)})`);
  const more = files.length > LISTED_IN_PROMPT ? `\n- … and ${files.length - LISTED_IN_PROMPT} more; use list_files to see them all` : '';
  const where = hostFolderPath
    ? `This chat's workspace is a real folder on the user's computer, at "${hostFolderPath}". Paths are relative to it and use forward slashes.`
    : 'This chat has a workspace: a folder for files that stays with the chat between replies. Paths are relative to it and use forward slashes.';
  return [
    `${where} ` +
      (commands
        ? 'Keep code in files there, and compile and run it with run_command, which starts in the workspace folder.'
        : 'You can create and edit files there; running programs is not available.'),
    files.length === 0 ? 'The workspace is empty.' : `Files in the workspace:\n${listed.join('\n')}${more}`,
  ].join('\n');
}

function describeCommand(settings: AppSettings, toolchains: string[], sandboxed: boolean): string {
  const { shell, commandTimeoutSeconds, maxCommandTimeoutSeconds, allowNetworkByDefault } = settings.workspace;
  const where = sandboxed
    ? `Run a shell command in a jail that can only see the chat's workspace folder, with ${allowNetworkByDefault ? 'network access unless network is set false' : 'no network access unless network is set true'}, and get back`
    : `Run a shell command on the user's computer (${platformName()}, ${shellName(shell)}) in the chat's workspace folder, and get back`;
  return (
    `${where} its exit code, output and the files it created or changed. Use it to compile, run, test or format the code in the workspace. ` +
    `Found ${sandboxed ? 'inside the sandbox' : 'on the PATH'}: ${toolchains.length ? toolchains.join(', ') : 'no common compilers or runtimes'}. ` +
    `Commands time out after ${commandTimeoutSeconds} seconds unless timeout_seconds asks for more (at most ${maxCommandTimeoutSeconds}). ` +
    'There is no input: programs that wait for the keyboard hang until the timeout, so pass input with arguments, files or a pipe. ' +
    'Use one command per call where you can, and paths inside the workspace. The user may be asked to approve each command.'
  );
}

/** The sandbox to run a call with, from settings and the model's own `network` argument, or null when sandboxing is off. */
function sandboxFor(limits: WorkspaceSettings, args: Record<string, unknown>): CommandOptions['sandbox'] {
  if (!limits.sandboxCommands) return null;
  const allowNetwork = typeof args.network === 'boolean' ? args.network : limits.allowNetworkByDefault;
  return { distro: limits.wslDistro, allowNetwork };
}

export function workspaceTools(workspaces: WorkspaceService): ToolSource {
  const listFiles: ToolDefinition = {
    group: 'files',
    label: 'List workspace files',
    defaultPolicy: 'auto',
    spec: {
      name: 'list_files',
      description: 'List the files in the chat’s workspace, or in one folder of it, with their sizes.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'A folder in the workspace (default: the whole workspace)' } },
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const folder = optionalString(args.path);
        const files = (await workspaces.exists(context.conversationId, context.hostFolderPath))
          ? await workspaces.files(context.conversationId, folder, context.hostFolderPath)
          : [];
        if (files.length === 0) return ok(folder ? `There are no files in "${folder}".` : 'The workspace is empty.');
        const total = files.reduce((sum, file) => sum + file.size, 0);
        const lines = files.map((file) => `${file.path}  (${size(file.size)})`);
        return ok(`${lines.join('\n')}\n\n${files.length} ${files.length === 1 ? 'file' : 'files'}, ${size(total)}.`);
      }),
  };

  const readFile: ToolDefinition = {
    group: 'files',
    label: 'Read a workspace file',
    defaultPolicy: 'auto',
    spec: {
      name: 'read_file',
      description: 'Read a text file from the workspace, whole or from a given line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'The file, relative to the workspace' },
          start_line: { type: 'integer', minimum: 1, description: 'First line to read (default 1)' },
          line_count: { type: 'integer', minimum: 1, maximum: 5_000, description: `Lines to read (default ${READ_DEFAULT_LINES})` },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const file = await workspaces.read(context.conversationId, String(args.path), context.hostFolderPath);
        if (file.text === null) return ok(`${file.path} is a binary file of ${size(file.size)}; it can't be shown as text.`);
        const lines = file.text.split(/\r?\n/);
        const start = typeof args.start_line === 'number' ? args.start_line : 1;
        const count = typeof args.line_count === 'number' ? args.line_count : READ_DEFAULT_LINES;
        if (start > lines.length) return { content: `Error: ${file.path} has only ${lines.length} lines.`, isError: true };
        let slice = lines.slice(start - 1, start - 1 + count).join('\n');
        let end = Math.min(lines.length, start - 1 + count);
        if (slice.length > READ_MAX_CHARS) {
          // Stop at the last whole line, so the next read starts where this one ended.
          const kept = slice.slice(0, READ_MAX_CHARS).split('\n');
          if (kept.length > 1) kept.pop();
          slice = kept.join('\n');
          end = start - 1 + kept.length;
        }
        const note = end < lines.length ? `[Lines ${start}–${end} of ${lines.length}. Continue with start_line ${end + 1}.]` : `[Lines ${start}–${lines.length} of ${lines.length}, end of file.]`;
        return ok(`${file.path}\n\n${slice}\n${note}`);
      }),
  };

  const writeFile: ToolDefinition = {
    group: 'files',
    label: 'Write a workspace file',
    defaultPolicy: 'auto',
    spec: {
      name: 'write_file',
      description: 'Create or replace a text file in the workspace, or append to it. Folders in the path are created as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'The file, relative to the workspace, e.g. "src/main.c"' },
          content: { type: 'string', description: 'The full text of the file, or the text to add when appending' },
          append: { type: 'boolean', description: 'Add to the end instead of replacing the file (default false)' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const result = await workspaces.write(
          context.conversationId,
          String(args.path),
          String(args.content),
          { append: args.append === true },
          context.hostFolderPath,
        );
        const verb = args.append === true ? 'Appended to' : result.created ? 'Created' : 'Replaced';
        return ok(`${verb} ${result.path} (${size(result.bytes)}).`);
      }),
  };

  const editFile: ToolDefinition = {
    group: 'files',
    label: 'Edit a workspace file',
    defaultPolicy: 'auto',
    spec: {
      name: 'edit_file',
      description:
        'Change part of a text file by replacing an exact piece of its text. old_text must match the file exactly, including indentation, ' +
        'and appear once unless replace_all is set. Prefer this to rewriting a whole file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'The file, relative to the workspace' },
          old_text: { type: 'string', minLength: 1, description: 'The text to replace, copied exactly from the file' },
          new_text: { type: 'string', description: 'The text to put in its place' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const result = await workspaces.edit(
          context.conversationId,
          String(args.path),
          String(args.old_text),
          String(args.new_text),
          args.replace_all === true,
          context.hostFolderPath,
        );
        return ok(`Edited ${result.path} (${result.replacements} ${result.replacements === 1 ? 'replacement' : 'replacements'}).`);
      }),
  };

  const deleteFile: ToolDefinition = {
    group: 'files',
    label: 'Delete a workspace file',
    defaultPolicy: 'auto',
    spec: {
      name: 'delete_file',
      description: 'Delete a file, or a folder with everything in it, from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, description: 'The file or folder, relative to the workspace' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const result = await workspaces.remove(context.conversationId, String(args.path), context.hostFolderPath);
        return ok(`Deleted ${result.folder ? 'folder' : 'file'} ${result.path}.`);
      }),
  };

  const moveFile: ToolDefinition = {
    group: 'files',
    label: 'Move a workspace file',
    defaultPolicy: 'auto',
    spec: {
      name: 'move_file',
      description: 'Move or rename a file or folder in the workspace. The destination must not exist.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', minLength: 1, description: 'The current path' },
          to: { type: 'string', minLength: 1, description: 'The new path' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        const result = await workspaces.move(context.conversationId, String(args.from), String(args.to), context.hostFolderPath);
        return ok(`Moved ${result.from} to ${result.to}.`);
      }),
  };

  const findInFiles: ToolDefinition = {
    group: 'files',
    label: 'Search workspace files',
    defaultPolicy: 'auto',
    spec: {
      name: 'find_in_files',
      description: 'Find the lines in the workspace’s text files that contain some text, ignoring case.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'The text to look for' },
          path: { type: 'string', description: 'A folder to search in (default: the whole workspace)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    run: (args, context) =>
      guarded(async () => {
        if (!(await workspaces.exists(context.conversationId, context.hostFolderPath))) return ok('The workspace is empty.');
        const { matches, truncated } = await workspaces.search(
          context.conversationId,
          String(args.query),
          optionalString(args.path),
          100,
          context.hostFolderPath,
        );
        if (matches.length === 0) return ok(`No lines contain "${String(args.query)}".`);
        const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
        return ok(`${lines.join('\n')}${truncated ? '\n[More matches were left out; narrow the search.]' : ''}`);
      }),
  };

  function runCommandTool(settings: AppSettings, toolchains: string[], sandboxed: boolean): ToolDefinition {
    return {
      group: 'commands',
      label: 'Run a command',
      defaultPolicy: 'ask',
      spec: {
        name: 'run_command',
        description: describeCommand(settings, toolchains, sandboxed),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1, description: 'The command line to run' },
            cwd: { type: 'string', description: 'A folder in the workspace to run it in (default: the workspace itself)' },
            timeout_seconds: {
              type: 'integer',
              minimum: 1,
              maximum: settings.workspace.maxCommandTimeoutSeconds,
              description: `Seconds before the command is stopped (default ${settings.workspace.commandTimeoutSeconds})`,
            },
            ...(sandboxed
              ? {
                  network: {
                    type: 'boolean',
                    description: `Let this command reach the network (default ${settings.workspace.allowNetworkByDefault})`,
                  },
                }
              : {}),
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      run: (args, context) =>
        guarded(async () => {
          const limits = context.settings.workspace;
          const conversationId = context.conversationId;
          const hostFolderPath = context.hostFolderPath;
          const sandbox = sandboxFor(limits, args);
          if (sandbox && !(await bwrapAvailable(sandbox.distro))) {
            return {
              content:
                'Error: Sandbox commands is on, but bubblewrap was not found in the configured WSL distro. Install it with ' +
                `"wsl -d ${sandbox.distro || '<distro>'} -- sudo apt install -y bubblewrap", or turn sandboxing off in Settings → Tools.`,
              isError: true,
            };
          }
          const dir = await workspaces.ensure(conversationId, hostFolderPath);
          const cwd = await workspaces.resolve(conversationId, optionalString(args.cwd), { allowRoot: true }, hostFolderPath);
          const before = await workspaces.snapshot(conversationId, hostFolderPath);
          const seconds = Math.min(typeof args.timeout_seconds === 'number' ? args.timeout_seconds : limits.commandTimeoutSeconds, limits.maxCommandTimeoutSeconds);
          const result = await runCommand({
            command: String(args.command),
            cwd: cwd.full,
            tempDir: join(dir, TEMP_FOLDER),
            timeoutMs: seconds * 1000,
            shell: limits.shell,
            outputChars: limits.outputChars,
            signal: context.signal,
            sandbox,
          });
          const after = await workspaces.snapshot(conversationId, hostFolderPath);
          const changed = [...after].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path);
          const deleted = [...before.keys()].filter((path) => !after.has(path));

          const took = `${(result.durationMs / 1000).toFixed(1)} s`;
          const status = result.stopped
            ? 'Stopped: the reply was stopped while the command ran.'
            : result.timedOut
              ? `Timed out after ${seconds} seconds; the command and everything it started were stopped.`
              : result.exitCode === null
                ? 'The command could not be started.'
                : `Exit code ${result.exitCode} after ${took}.`;
          const parts = [
            status,
            result.stdout ? `Output:\n${result.stdout}` : 'No output.',
            result.stderr ? `Errors:\n${result.stderr}` : null,
            changed.length ? `Files created or changed: ${changed.join(', ')}` : null,
            deleted.length ? `Files deleted: ${deleted.join(', ')}` : null,
          ];
          if (!hostFolderPath) {
            const used = await workspaces.usage(conversationId, hostFolderPath);
            const quota = await workspaces.quota();
            if (used > quota) {
              parts.push(`Warning: the workspace now holds ${size(used)}, over its ${size(quota)} limit. Writing files is blocked until some are deleted.`);
            }
          }
          return { content: parts.filter(Boolean).join('\n\n'), isError: result.exitCode !== 0 };
        }),
    };
  }

  return {
    groups: async () => [FILES_GROUP, COMMANDS_GROUP],
    tools: async (settings) => {
      const sandboxed = settings.workspace.sandboxCommands;
      const toolchains = sandboxed ? await detectSandboxToolchains(settings.workspace.wslDistro) : await detectToolchains();
      return [listFiles, readFile, writeFile, editFile, deleteFile, moveFile, findInFiles, runCommandTool(settings, toolchains, sandboxed)];
    },
  };
}
