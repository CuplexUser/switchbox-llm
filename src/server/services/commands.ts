import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { WorkspaceShell } from '../../shared/types.ts';

export interface CommandResult {
  /** Null when the process was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** The reply was stopped while the command ran. */
  stopped: boolean;
}

export interface CommandOptions {
  command: string;
  cwd: string;
  /** TEMP, TMP and TMPDIR point here. */
  tempDir: string;
  timeoutMs: number;
  shell: WorkspaceShell;
  /** Characters of each stream to keep; the start and end are kept when there is more. */
  outputChars: number;
  signal?: AbortSignal;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Environment variables a command may see. Everything else stays behind, above all the API keys
 * the server loads from .env. The ones here are what shells, compilers and package managers need
 * to find themselves and their caches.
 */
const PASSED_VARIABLES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'COMMONPROGRAMFILES',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'JAVA_HOME',
  'GOROOT',
  'GOPATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOTNET_ROOT',
];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** The environment a command runs with: the allowed variables, temp folders in the workspace and plain output. */
export function commandEnvironment(tempDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const byUpper = new Map(Object.entries(source).map(([name, value]) => [name.toUpperCase(), [name, value] as const]));
  for (const wanted of PASSED_VARIABLES) {
    const found = byUpper.get(wanted);
    if (found && found[1] !== undefined && !SECRET_NAME.test(found[0])) env[found[0]] = found[1];
  }
  return {
    ...env,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    NO_COLOR: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
}

/** Git for Windows' bash, which is what "bash" should mean there rather than WSL's launcher. */
function windowsBash(): string {
  const candidates = [
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
  ];
  return candidates.find((path) => existsSync(path)) ?? 'bash';
}

/** A human name for the shell, for the tool description. */
export function shellName(shell: WorkspaceShell): string {
  if (shell === 'powershell') return IS_WINDOWS ? 'Windows PowerShell' : 'PowerShell (pwsh)';
  if (shell === 'bash') return IS_WINDOWS ? 'bash (Git for Windows)' : 'bash';
  return IS_WINDOWS ? 'cmd.exe' : '/bin/sh';
}

export function platformName(): string {
  if (IS_WINDOWS) return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return process.platform === 'linux' ? 'Linux' : process.platform;
}

function start(options: CommandOptions): ChildProcess {
  const common = {
    cwd: options.cwd,
    env: commandEnvironment(options.tempDir),
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Its own process group elsewhere, so the whole tree can be killed at once.
    detached: !IS_WINDOWS,
  };
  if (options.shell === 'powershell') {
    return spawn(IS_WINDOWS ? 'powershell.exe' : 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', options.command], common);
  }
  if (options.shell === 'bash') return spawn(IS_WINDOWS ? windowsBash() : 'bash', ['-c', options.command], common);
  return spawn(options.command, { ...common, shell: true });
}

/** Kills the process and everything it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Keeps the start of a stream and a rolling window of its end, so a flood of output can't fill memory. */
class OutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;
  private readonly limit: number;

  constructor(chars: number) {
    // UTF-8 is at most 4 bytes a character, so this holds at least `chars` characters at each end.
    this.limit = chars * 4;
  }

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (this.headBytes < this.limit) {
      const take = chunk.subarray(0, this.limit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.byteLength;
      chunk = chunk.subarray(take.byteLength);
    }
    if (chunk.byteLength === 0) return;
    const joined = Buffer.concat([this.tail, chunk]);
    this.tail = joined.subarray(Math.max(0, joined.byteLength - this.limit));
  }

  text(chars: number): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const skipped = this.total - this.headBytes - this.tail.byteLength;
    const tail = this.tail.toString('utf8');
    const half = Math.floor(chars / 2);
    const note = `\n[… output cut: ${this.total.toLocaleString('en-US')} bytes in all, showing the start and the end …]\n`;
    if (skipped > 0) return head.slice(0, half) + note + tail.slice(-half);
    const whole = head + tail;
    return whole.length <= chars ? whole : whole.slice(0, half) + note + whole.slice(-half);
  }
}

/**
 * Runs one command in a workspace folder. This is an ordinary process on this machine, not a
 * sandbox: the protections are the approval step, the reduced environment, the timeout and
 * killing the whole process tree when time runs out or the reply is stopped.
 */
export function runCommand(options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const stdout = new OutputBuffer(options.outputChars);
    const stderr = new OutputBuffer(options.outputChars);
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let child: ChildProcess;

    const finish = (exitCode: number | null, extraError = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const errors = stderr.text(options.outputChars);
      resolve({
        exitCode,
        stdout: stdout.text(options.outputChars),
        stderr: extraError ? (errors ? `${errors}\n${extraError}` : extraError) : errors,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        stopped,
      });
    };
    const onAbort = () => {
      stopped = true;
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    try {
      child = start(options);
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(timedOut || stopped ? null : code));
  });
}

const TOOLCHAINS = ['node', 'python', 'python3', 'gcc', 'g++', 'clang', 'cl', 'dotnet', 'java', 'javac', 'go', 'rustc', 'cargo', 'make', 'cmake', 'git'];
let detected: Promise<string[]> | null = null;

/** Which common compilers and runtimes are on the PATH, looked up once. */
export function detectToolchains(): Promise<string[]> {
  detected ??= Promise.all(
    TOOLCHAINS.map(
      (name) =>
        new Promise<string | null>((resolve) => {
          const probe = spawn(IS_WINDOWS ? 'where' : 'which', [name], { stdio: 'ignore', windowsHide: true, env: commandEnvironment(process.cwd()) });
          const timer = setTimeout(() => probe.kill(), 5_000);
          probe.on('error', () => resolve(null));
          probe.on('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? name : null);
          });
        }),
    ),
  ).then((names) => names.filter((name): name is string => name !== null));
  return detected;
}
