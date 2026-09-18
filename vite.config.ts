import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 8787);

// While the API server restarts in watch mode, proxied requests are refused. Vite logs each one
// with a full stack trace; print one short line per outage instead.
const logger = createLogger();
const logError = logger.error.bind(logger);
let apiDown = false;
logger.error = (msg, options) => {
  if ((options?.error as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED') {
    if (!apiDown) logger.warn(`API server on port ${serverPort} is not reachable yet (restarting?)`, { timestamp: true });
    apiDown = true;
    return;
  }
  logError(msg, options);
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyRes', () => (apiDown = false)),
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
