import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, 'client'),
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'client/src'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api':      { target: 'http://localhost:3206', changeOrigin: true },
      '/health':   { target: 'http://localhost:3206', changeOrigin: true },
      '/webhooks': { target: 'http://localhost:3206', changeOrigin: true },
    },
  },
});
