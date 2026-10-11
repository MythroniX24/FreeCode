import { defineConfig } from 'vitest/config';

/**
 * The gateway's own test run.
 *
 * Kept separate from the root config for one reason: the integration suite binds
 * a real HTTP server on an ephemeral port and serves real streams. That is the
 * right way to test a server — driving Fastify in-process would not exercise the
 * socket, the SSE framing, or the abort handling — but it is slower and needs its
 * own timeout, so it does not belong in the fast unit run every author triggers.
 *
 * The root `vitest.config.ts` *excludes* these files explicitly, so running the
 * full suite and running `npm run test:gateway` do not double-run them.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/gateway/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file gets its own process: several bind servers, and sharing a worker
    // would serialise them and leak signal handlers between files.
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@freecode/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
});
