import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  appType: 'mpa',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        live: resolve(__dirname, 'live.html'),
        admin: resolve(__dirname, 'admin.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
});
