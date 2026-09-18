import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Tests never touch the real workspaces under ./data.
    env: { LOG_LEVEL: 'error', WORKSPACE_DIR: join(tmpdir(), `switchbox-test-workspaces-${process.pid}`) },
  },
});
