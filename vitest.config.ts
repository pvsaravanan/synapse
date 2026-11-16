import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The default forks pool hangs when several files load node:sqlite in parallel on macOS; threads is stable.
    pool: 'threads',
    testTimeout: 20_000,
  },
});
