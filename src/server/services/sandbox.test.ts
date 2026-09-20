import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildSandboxArgs, bwrapAvailable, translateToWslPath } from './sandbox.ts';

describe('translateToWslPath', () => {
  it('converts a Windows drive path to its WSL (DrvFs) form', () => {
    expect(translateToWslPath('D:\\Code\\switchbox-llm\\data')).toBe('/mnt/d/Code/switchbox-llm/data');
    expect(translateToWslPath('C:/Users/me')).toBe('/mnt/c/Users/me');
  });

  it('refuses a UNC path', () => {
    expect(translateToWslPath('\\\\server\\share\\folder')).toBeNull();
  });
});

describe('buildSandboxArgs', () => {
  it('builds a bwrap invocation bound to the workspace, isolating the network by default', () => {
    const built = buildSandboxArgs({
      command: 'echo hi',
      cwd: 'D:\\data\\workspaces\\chat-1',
      tempDir: 'D:\\data\\workspaces\\chat-1\\.tmp',
      distro: '',
      allowNetwork: false,
    });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    const joined = built.wslArgs.join(' ');
    expect(joined).toContain('--bind /mnt/d/data/workspaces/chat-1 /mnt/d/data/workspaces/chat-1');
    expect(joined).toContain('--unshare-all');
    expect(joined).not.toContain('--share-net');
    expect(built.wslArgs.at(-1)).toBe('echo hi');
  });

  it('re-shares the network when allowed', () => {
    const built = buildSandboxArgs({ command: 'x', cwd: 'D:\\a', tempDir: 'D:\\a\\.tmp', distro: 'Ubuntu', allowNetwork: true });
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.wslArgs.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
    expect(built.wslArgs).toContain('--share-net');
  });

  it('refuses a UNC path it cannot translate', () => {
    const built = buildSandboxArgs({ command: 'x', cwd: '\\\\server\\share', tempDir: '\\\\server\\share\\.tmp', distro: '', allowNetwork: false });
    expect('error' in built).toBe(true);
  });
});

const hasWsl = spawnSync('wsl.exe', ['--status'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasWsl)('bwrapAvailable (live WSL)', () => {
  // A cold WSL session can take a while to come up, especially alongside other test files spawning wsl.exe too.
  it('reports whether bwrap is installed in the default distro, without throwing', { timeout: 20_000 }, async () => {
    await expect(bwrapAvailable('')).resolves.toEqual(expect.any(Boolean));
  });
});
