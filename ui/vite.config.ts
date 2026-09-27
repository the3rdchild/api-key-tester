import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // WebSocket upgrades must be matched before the plain /api rule, and need
      // ws:true or the realtime proxy socket never upgrades in dev.
      '/api/realtime': {
        target: 'ws://127.0.0.1:8788',
        ws: true,
      },
      '/api': 'http://127.0.0.1:8788',
      '/live': {
        target: 'ws://127.0.0.1:8788',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
