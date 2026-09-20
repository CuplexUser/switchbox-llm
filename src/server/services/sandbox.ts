import { spawn } from 'node:child_process';

/** Compilers and runtimes run_command's description looks for, on the Windows PATH or inside the sandbox. */
export const TOOLCHAINS = ['node', 'python', 'python3', 'gcc', 'g++', 'clang', 'cl', 'dotnet', 'java', 'javac', 'go', 'rustc', 'cargo', 'make', 'cmake', 'git'];

/** Read-only binds every jailed command gets, so it has a working system: a shell, an interpreter, certs. Missing ones are skipped. */
const BASE_BINDS = ['/usr', '/bin', '/lib', '/lib64', '/lib32', '/etc/alternatives', '/etc/ssl', '/etc/resolv.conf'];

/** A Windows drive path as WSL sees it (DrvFs), or null for anything sandboxing can't reach, such as a UNC path. */
export function translateToWslPath(windowsPath: string): string | null {
  const match = /^([a-zA-Z]):\/(.*)$/.exec(windowsPath.replace(/\\/g, '/'));
  if (!match?.[1]) return null;
  return `/mnt/${match[1].toLowerCase()}/${match[2] ?? ''}`;
}

/** Env vars set inside the jail explicitly, since it doesn't inherit the Windows process's environment. */
function sandboxEnvironment(wslTempDir: string): [string, string][] {
  return [
    ['HOME', '/tmp'],
    ['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    ['TEMP', wslTempDir],
    ['TMP', wslTempDir],
    ['TMPDIR', wslTempDir],
    ['LANG', 'C.UTF-8'],
    ['NO_COLOR', '1'],
    ['PYTHONUNBUFFERED', '1'],
    ['PYTHONIOENCODING', 'utf-8'],
    ['DOTNET_CLI_TELEMETRY_OPTOUT', '1'],
  ];
}

export interface SandboxRequest {
  command: string;
  cwd: string;
  tempDir: string;
  distro: string;
  allowNetwork: boolean;
}

/** The `wsl.exe` argument list that runs `command` inside a bubblewrap jail seeing only the workspace folder. */
export function buildSandboxArgs(request: SandboxRequest): { wslArgs: string[] } | { error: string } {
  const wslCwd = translateToWslPath(request.cwd);
  const wslTemp = translateToWslPath(request.tempDir);
  if (!wslCwd || !wslTemp) return { error: 'Sandboxing only works with a local drive path, not a network path.' };

  const bwrapArgs = ['--unshare-all'];
  if (request.allowNetwork) bwrapArgs.push('--share-net');
  for (const path of BASE_BINDS) bwrapArgs.push('--ro-bind-try', path, path);
  bwrapArgs.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  bwrapArgs.push('--bind', wslCwd, wslCwd);
  if (wslTemp !== wslCwd) bwrapArgs.push('--bind', wslTemp, wslTemp);
  bwrapArgs.push('--chdir', wslCwd, '--die-with-parent', '--new-session');
  for (const [name, value] of sandboxEnvironment(wslTemp)) bwrapArgs.push('--setenv', name, value);
  bwrapArgs.push('--', '/bin/sh', '-c', request.command);

  const wslArgs = [...(request.distro ? ['-d', request.distro] : []), '--', 'bwrap', ...bwrapArgs];
  return { wslArgs };
}

function wslProbe(distro: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('wsl.exe', [...(distro ? ['-d', distro] : []), '--', ...args], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => probe.kill(), 5_000);
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const bwrapCache = new Map<string, Promise<boolean>>();

/** Whether `bwrap` can be found in the given WSL distro, cached per distro since it only changes when the user installs it. */
export function bwrapAvailable(distro: string): Promise<boolean> {
  const key = distro || '\0default';
  let cached = bwrapCache.get(key);
  if (!cached) {
    cached = wslProbe(distro, ['which', 'bwrap']);
    bwrapCache.set(key, cached);
  }
  return cached;
}

const toolchainCache = new Map<string, Promise<string[]>>();

/** Which of `run_command`'s known toolchains are reachable inside the WSL distro itself, not the Windows PATH. */
export function detectSandboxToolchains(distro: string): Promise<string[]> {
  const key = distro || '\0default';
  let cached = toolchainCache.get(key);
  if (!cached) {
    cached = Promise.all(TOOLCHAINS.map(async (name) => ((await wslProbe(distro, ['which', name])) ? name : null))).then((names) =>
      names.filter((name): name is string => name !== null),
    );
    toolchainCache.set(key, cached);
  }
  return cached;
}
