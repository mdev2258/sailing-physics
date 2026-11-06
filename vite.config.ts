import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  test: { environment: 'node', testTimeout: 60000 },
} as any);
