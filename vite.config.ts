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
      // Unauthenticated share/guest API used by PublicRoadmap (/r/:token) and GuestView (/g/:token)
      '/public':   { target: 'http://localhost:3206', changeOrigin: true },
    },
  },
});
