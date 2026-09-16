import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${serverPort}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
