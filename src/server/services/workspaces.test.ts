import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaults.ts';
import type { WorkspaceSettings } from '../../shared/types.ts';
import type { LoopMessage } from '../providers/types.ts';
import type { WebPlan } from '../tools/types.ts';
import { commandEnvironment, runCommand } from './commands.ts';
import { doneMessage, FakeProvider, seedConversation, send, setup, tempWorkspaceDir } from './testing.ts';
import { assertBindableRoot, cleanPath, WorkspaceError, WorkspaceService } from './workspaces.ts';

const CHAT = 'chat-1';

function service(limits: Partial<WorkspaceSettings> = {}): WorkspaceService {
  return new WorkspaceService(tempWorkspaceDir(), async () => ({ ...DEFAULT_SETTINGS.workspace, ...limits }));
}

describe('workspace paths', () => {
  it('accepts relative paths and normalizes them', () => {
    expect(cleanPath('src\\main.c')).toBe('src/main.c');
    expect(cleanPath('./a//b/./c.txt')).toBe('a/b/c.txt');
    expect(cleanPath('')).toBe('');
  });

  it.each([
    ['../outside.txt'],
    ['a/../../outside.txt'],
    ['/etc/passwd'],
    ['\\\\server\\share'],
    ['C:/Windows/win.ini'],
    ['c:relative.txt'],
    ['file.txt:stream'],
    ['CON'],
    ['nul.txt'],
    ['dir/com1.log'],
    ['trailing.'],
  ])('refuses %s', (path) => {
    expect(() => cleanPath(path)).toThrow(WorkspaceError);
  });

  it('refuses a link that points outside the workspace', async () => {
    const workspaces = service();
    await workspaces.write(CHAT, 'inside.txt', 'x');
    const outside = mkdtempSync(join(tmpdir(), 'switchbox-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    // Junctions need no special rights on Windows.
    symlinkSync(outside, join(workspaces.dirFor(CHAT), 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(workspaces.read(CHAT, 'link/secret.txt')).rejects.toThrow(WorkspaceError);
    await expect(workspaces.write(CHAT, 'link/new.txt', 'x')).rejects.toThrow(WorkspaceError);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    // Listings don't follow links either.
    expect((await workspaces.files(CHAT)).map((file) => file.path)).toEqual(['inside.txt']);
  });

  it('refuses chat ids that are not plain ids', () => {
    expect(() => service().dirFor('../x')).toThrow(WorkspaceError);
  });
});

describe('workspace files', () => {
  it('creates nothing until the first write', async () => {
    const workspaces = service();
    expect(await workspaces.listing(CHAT)).toMatchObject({ files: [], usage: 0, exists: false });
    expect(existsSync(workspaces.dirFor(CHAT))).toBe(false);
    await workspaces.write(CHAT, 'a/b.txt', 'hello');
    expect(await workspaces.listing(CHAT)).toMatchObject({ files: [{ path: 'a/b.txt', size: 5 }], usage: 5, exists: true });
  });

  it('reads text, reports binary files and appends', async () => {
    const workspaces = service();
    await workspaces.write(CHAT, 'log.txt', 'one\n');
    await workspaces.write(CHAT, 'log.txt', 'two\n', { append: true });
    expect((await workspaces.read(CHAT, 'log.txt')).text).toBe('one\ntwo\n');
    await workspaces.write(CHAT, 'blob.bin', new Uint8Array([0, 1, 2, 0]));
    expect(await workspaces.read(CHAT, 'blob.bin')).toMatchObject({ text: null, size: 4 });
    await expect(workspaces.read(CHAT, 'missing.txt')).rejects.toThrow('There is no file');
  });

  it('edits exact text once, or everywhere when asked', async () => {
    const workspaces = service();
    await workspaces.write(CHAT, 'main.c', 'int a = 1;\nint b = 1;\n');
    await expect(workspaces.edit(CHAT, 'main.c', '= 1', '= 2')).rejects.toThrow('appears 2 times');
    await expect(workspaces.edit(CHAT, 'main.c', 'missing', 'x')).rejects.toThrow('not found');
    expect(await workspaces.edit(CHAT, 'main.c', 'int a = 1', 'int a = $&3')).toEqual({ path: 'main.c', replacements: 1 });
    expect(await workspaces.edit(CHAT, 'main.c', '1;', '9;', true)).toEqual({ path: 'main.c', replacements: 1 });
    expect((await workspaces.read(CHAT, 'main.c')).text).toBe('int a = $&3;\nint b = 9;\n');
  });

  it('moves, deletes and searches', async () => {
    const workspaces = service();
    await workspaces.write(CHAT, 'src/a.py', 'print("Hello")\n');
    await workspaces.write(CHAT, 'src/b.py', 'x = 1\n');
    await workspaces.move(CHAT, 'src/a.py', 'app/main.py');
    await expect(workspaces.move(CHAT, 'src/b.py', 'app/main.py')).rejects.toThrow('already exists');
    expect((await workspaces.search(CHAT, 'hello')).matches).toEqual([{ path: 'app/main.py', line: 1, text: 'print("Hello")' }]);
    await workspaces.remove(CHAT, 'src');
    expect((await workspaces.files(CHAT)).map((file) => file.path)).toEqual(['app/main.py']);
  });

  it('enforces the file size and quota limits', async () => {
    const workspaces = service({ maxFileMb: 1, quotaMb: 2 });
    const mb = new Uint8Array(1024 * 1024);
    await expect(workspaces.write(CHAT, 'big.bin', new Uint8Array(1024 * 1024 + 1))).rejects.toThrow('limited to 1 MB');
    await workspaces.write(CHAT, 'one.bin', mb);
    await workspaces.write(CHAT, 'two.bin', mb);
    await expect(workspaces.write(CHAT, 'three.bin', new Uint8Array(10))).rejects.toThrow('over its 2 MB limit');
    // Replacing a file only counts the difference.
    await workspaces.write(CHAT, 'two.bin', new Uint8Array(10));
    await workspaces.write(CHAT, 'three.bin', new Uint8Array(10));
  });

  it('copies a workspace for a branch and deletes one with its chat', async () => {
    const workspaces = service();
    await workspaces.write(CHAT, 'notes.md', '# Notes');
    await workspaces.copy(CHAT, 'chat-2');
    await workspaces.write(CHAT, 'notes.md', 'changed');
    expect((await workspaces.read('chat-2', 'notes.md')).text).toBe('# Notes');
    await workspaces.deleteFor(CHAT);
    expect(await workspaces.exists(CHAT)).toBe(false);
    expect(await workspaces.prune(new Set())).toBe(1);
    expect(await workspaces.exists('chat-2')).toBe(false);
  });
});

describe('assertBindableRoot', () => {
  it('accepts an existing absolute folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchbox-bindable-'));
    expect(await assertBindableRoot(dir)).toBe(dir);
  });

  it('refuses a relative path, a missing folder and a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchbox-bindable-'));
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    await expect(assertBindableRoot('relative/path')).rejects.toThrow(WorkspaceError);
    await expect(assertBindableRoot(join(dir, 'missing'))).rejects.toThrow(WorkspaceError);
    await expect(assertBindableRoot(file)).rejects.toThrow(WorkspaceError);
  });

  it('refuses a whole drive root', async () => {
    if (process.platform !== 'win32') return;
    await expect(assertBindableRoot('C:\\')).rejects.toThrow('whole drive');
  });
});

function bound(): string {
  return mkdtempSync(join(tmpdir(), 'switchbox-bound-'));
}

describe('bound workspace root', () => {
  it('reads and writes in the bound folder instead of the owned one', async () => {
    const workspaces = service();
    const root = bound();
    await workspaces.write(CHAT, 'notes.md', 'hello', {}, root);
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('hello');
    expect(existsSync(workspaces.dirFor(CHAT))).toBe(false);
    expect((await workspaces.files(CHAT, '', root)).map((file) => file.path)).toEqual(['notes.md']);
  });

  it('still refuses escapes and links out of a bound folder', async () => {
    const workspaces = service();
    const root = bound();
    await workspaces.write(CHAT, 'inside.txt', 'x', {}, root);
    const outside = bound();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(workspaces.read(CHAT, '../escape.txt', root)).rejects.toThrow(WorkspaceError);
    await expect(workspaces.read(CHAT, 'link/secret.txt', root)).rejects.toThrow(WorkspaceError);
  });

  it('skips the total quota but keeps the per-file limit for a bound folder', async () => {
    const workspaces = service({ maxFileMb: 1, quotaMb: 1 });
    const root = bound();
    await expect(workspaces.write(CHAT, 'big.bin', new Uint8Array(1024 * 1024 + 1), {}, root)).rejects.toThrow('limited to 1 MB');
    // Two 1 MB files would be over the 1 MB quota for an owned folder, but this one is bound.
    await workspaces.write(CHAT, 'one.bin', new Uint8Array(1024 * 1024), {}, root);
    await workspaces.write(CHAT, 'two.bin', new Uint8Array(1024 * 1024), {}, root);
  });

  it('never deletes a bound folder when the chat is deleted, only the owned one', async () => {
    const workspaces = service();
    const root = bound();
    await workspaces.write(CHAT, 'notes.md', 'hello', {}, root);
    await workspaces.deleteFor(CHAT);
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('hello');
  });

  it('clear() empties a bound folder’s contents without removing the folder itself', async () => {
    const workspaces = service();
    const root = bound();
    await workspaces.write(CHAT, 'notes.md', 'hello', {}, root);
    await workspaces.clear(CHAT, root);
    expect(existsSync(root)).toBe(true);
    expect(await workspaces.files(CHAT, '', root)).toEqual([]);
  });
});

function folder(): { cwd: string; tempDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'switchbox-command-'));
  const tempDir = join(cwd, '.tmp');
  mkdirSync(tempDir);
  return { cwd, tempDir };
}

const toolResults = (messages: LoopMessage[]) => messages.filter((message) => message.role === 'tool');

describe('runCommand', () => {
  const base = { timeoutMs: 20_000, shell: 'system' as const, outputChars: 20_000 };

  it('returns the exit code and both streams', async () => {
    const result = await runCommand({ ...base, ...folder(), command: 'node -e "console.log(1+1); console.error(2+2); process.exit(3)"' });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, stopped: false });
    expect(result.stdout.trim()).toBe('2');
    expect(result.stderr.trim()).toBe('4');
  });

  it('keeps API keys out of the environment', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    try {
      expect(commandEnvironment('/tmp')).not.toHaveProperty('ANTHROPIC_API_KEY');
      const result = await runCommand({ ...base, ...folder(), command: 'node -e "console.log(process.env.ANTHROPIC_API_KEY || \'none\')"' });
      expect(result.stdout.trim()).toBe('none');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('keeps the start and end of long output', async () => {
    const result = await runCommand({ ...base, ...folder(), outputChars: 1_000, command: 'node -e "process.stdout.write(\'a\'.repeat(50000) + \'END\')"' });
    expect(result.stdout).toContain('output cut');
    expect(result.stdout.startsWith('aaa')).toBe(true);
    expect(result.stdout.endsWith('END')).toBe(true);
    expect(result.stdout.length).toBeLessThan(1_200);
  });

  it('kills the whole process tree at the timeout', async () => {
    const { cwd, tempDir } = folder();
    writeFileSync(join(cwd, 'child.js'), "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);");
    writeFileSync(join(cwd, 'parent.js'), "require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' }); setInterval(() => {}, 1000);");
    const result = await runCommand({ ...base, cwd, tempDir, timeoutMs: 1_500, command: 'node parent.js' });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    const pid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'));
    // taskkill returns before Windows has finished removing the process.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => process.kill(pid, 0)).toThrow('ESRCH');
  });

  it('stops when the reply is stopped', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runCommand({ ...base, ...folder(), signal: controller.signal, command: 'node -e "setInterval(() => {}, 1000)"' });
    expect(result).toMatchObject({ stopped: true, exitCode: null });
  });
});

// Only runs on a machine with WSL2 and bubblewrap set up (`wsl -d <distro> -- sudo apt install -y bubblewrap`) —
// not something CI or every dev machine has, so it's skipped rather than failed when unavailable.
const sandboxReady =
  spawnSync('wsl.exe', ['--status'], { stdio: 'ignore' }).status === 0 && spawnSync('wsl.exe', ['--', 'which', 'bwrap'], { stdio: 'ignore' }).status === 0;

const sandbox = (allowNetwork: boolean) => ({ distro: '', allowNetwork });

describe.runIf(sandboxReady)('runCommand sandboxed (live WSL + bwrap)', () => {
  const base = { timeoutMs: 20_000, shell: 'system' as const, outputChars: 20_000 };

  // A cold WSL session, plus other test files spawning wsl.exe at the same time, can be slower than vitest's default 5s.
  const SANDBOX_TEST_TIMEOUT = 30_000;

  it(
    'reads and writes files in the bound workspace folder',
    async () => {
      const { cwd, tempDir } = folder();
      const result = await runCommand({ ...base, cwd, tempDir, sandbox: sandbox(false), command: 'echo hello > out.txt && cat out.txt' });
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout.trim()).toBe('hello');
      expect(readFileSync(join(cwd, 'out.txt'), 'utf8').trim()).toBe('hello');
    },
    SANDBOX_TEST_TIMEOUT,
  );

  it(
    'cannot read files outside the bound folder',
    async () => {
      const result = await runCommand({ ...base, ...folder(), sandbox: sandbox(false), command: 'cat /etc/passwd' });
      expect(result.exitCode).not.toBe(0);
    },
    SANDBOX_TEST_TIMEOUT,
  );

  it(
    'has no network by default, but reaches it when allowed',
    async () => {
      const command = 'python3 -c "import socket; socket.create_connection((\'1.1.1.1\', 80), timeout=5); print(\'reached\')"';
      const blocked = await runCommand({ ...base, ...folder(), sandbox: sandbox(false), command });
      expect(blocked.exitCode).not.toBe(0);
      const allowed = await runCommand({ ...base, ...folder(), sandbox: sandbox(true), command });
      expect(allowed.stdout.trim()).toBe('reached');
    },
    SANDBOX_TEST_TIMEOUT,
  );

  it(
    'compiles and runs C code with the sandbox’s own toolchain',
    async () => {
      const { cwd, tempDir } = folder();
      writeFileSync(join(cwd, 'hi.c'), '#include <stdio.h>\nint main(void){printf("hi from sandbox\\n");return 0;}');
      const result = await runCommand({ ...base, cwd, tempDir, sandbox: sandbox(false), command: 'gcc hi.c -o hi && ./hi' });
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout.trim()).toBe('hi from sandbox');
    },
    SANDBOX_TEST_TIMEOUT,
  );

  it(
    'killing the process tears down everything inside the jail',
    async () => {
      const { cwd, tempDir } = folder();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);
      const result = await runCommand({
        ...base,
        cwd,
        tempDir,
        sandbox: sandbox(false),
        signal: controller.signal,
        command: 'echo started > started.txt && sleep 30',
      });
      expect(result).toMatchObject({ stopped: true, exitCode: null });
      expect(readFileSync(join(cwd, 'started.txt'), 'utf8').trim()).toBe('started');
    },
    SANDBOX_TEST_TIMEOUT,
  );
});

const NO_WEB: WebPlan = { search: null, fetch: false, nativeSearch: false, resolved: 'none', note: null };

describe('workspace tools', () => {
  it('are offered only when the chat has its workspace on, and commands only when switched on too', async () => {
    const services = setup(new FakeProvider(() => []));
    const settings = await services.settings.getAll();
    const names = async (options: { workspace: boolean; toolGroups?: Record<string, boolean> }) => {
      const { conversation } = await seedConversation(services.repos, options);
      const tools = await services.tools.resolve({ conversation, settings, web: NO_WEB, profileTools: null, attachments: [] });
      return tools.map((tool) => tool.spec.name).filter((name) => ['write_file', 'run_command'].includes(name));
    };
    expect(await names({ workspace: false })).toEqual([]);
    expect(await names({ workspace: true })).toEqual(['write_file']);
    expect(await names({ workspace: true, toolGroups: { commands: true } })).toEqual(['write_file', 'run_command']);
    expect(await names({ workspace: false, toolGroups: { commands: true } })).toEqual([]);

    const catalog = await services.tools.catalog(settings);
    const commands = catalog.find((group) => group.id === 'commands');
    expect(commands).toMatchObject({ onByDefault: false, requires: 'workspace', tools: [{ name: 'run_command', policy: 'ask' }] });
  });

  it('lets a model write a file and read it back, with the files in the system prompt', async () => {
    const provider = new FakeProvider((request) => {
      const done = toolResults(request.messages).length;
      if (done === 0) return [{ type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: '{"path":"hello.py","content":"print(1)"}' } }];
      if (done === 1) return [{ type: 'tool_call', call: { id: 'r1', name: 'read_file', arguments: '{"path":"hello.py"}' } }];
      return [{ type: 'text', text: 'Written.' }];
    });
    const services = setup(provider);
    const { conversation, pane } = await seedConversation(services.repos, { useMemory: false, workspace: true });

    const events = await send(services, conversation.id, [pane.id], 'Write hello.py');
    expect(doneMessage(events)?.content).toBe('Written.');
    expect(provider.requests[0]?.system).toContain('The workspace is empty.');
    const read = toolResults(provider.requests[2]?.messages ?? []).at(-1);
    expect(read?.content).toContain('print(1)');
    expect((await services.workspaces.read(conversation.id, 'hello.py')).text).toBe('print(1)');

    await send(services, conversation.id, [pane.id], 'Again');
    expect(provider.requests.at(-1)?.system).toContain('- hello.py (8 B)');
  });
});
