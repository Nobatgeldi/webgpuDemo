import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the production build works from any static host path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
