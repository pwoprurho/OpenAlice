import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Single process, sequential execution. E2E tests share stateful broker
// connections (IBKR TCP + clientId, REST API sessions). Module-level
// singletons in setup.ts require same-process to actually share state.
export default {
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.e2e.spec.*'],
    testTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Cap CCXT init retries during e2e — production defaults (8 retries with
    // exponential backoff) burn ~140s per market type when a testnet is
    // unreachable, blocking the entire serial setup. 2 retries × 250ms base
    // bounds a failing init's backoff to under a second (the bulk of the time
    // is still the underlying CCXT HTTP timeouts, which setup.ts caps with
    // its own 30s per-broker race).
    env: {
      CCXT_INIT_RETRIES: '2',
      CCXT_INIT_RETRY_BASE_MS: '250',
    },
  },
}
