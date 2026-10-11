/**
 * Gateway entry point.
 *
 * Deliberately thin: parse configuration, assemble the dependencies, start the
 * server, and shut down *gracefully* on a signal. Everything that is worth
 * testing lives in the modules this imports, so this file's only job is to get
 * the wiring right exactly once.
 *
 * **Refusing to start is a feature.** A gateway with no providers, or with a
 * provider whose key cannot be resolved, is a deployment that will fail every
 * request; it fails at boot, loudly, instead. The one case where it starts
 * anyway is a *partial* upstream failure — three providers up and one down is a
 * degraded but useful service, and blocking it would be wrong.
 *
 * **The memory store is called out at boot.** A production deployment that
 * forgot `GATEWAY_DATABASE_URL` would run with per-process quotas and lose its
 * ledger on restart. That warning is the last chance to notice.
 */

import process from 'node:process';

import { ConfigError, Logger, VERSION, streamSink, toFreecodeError } from '@freecode/core';

import { parseGatewayConfig, type GatewayConfig } from './config.js';
import { QuotaLimiter } from './quota/limiter.js';
import { buildApp } from './server/app.js';
import { Authenticator } from './server/auth.js';
import type { RouteDeps } from './server/deps.js';
import { MemoryUsageStore } from './store/memory.js';
import { PostgresUsageStore } from './store/postgres.js';
import type { UsageStore } from './store/types.js';
import { buildCatalogue } from './upstream/catalogue.js';
import { ProviderResolver } from './upstream/resolver.js';

export interface StartedGateway {
  readonly config: GatewayConfig;
  readonly deps: RouteDeps;
  readonly address: string;
  close(): Promise<void>;
}

/**
 * Assemble and start a gateway.
 *
 * Exported (not inlined into `main`) so an integration test can start a real
 * server on an ephemeral port against a memory store and drive it over HTTP.
 */
export async function startGateway(
  config: GatewayConfig,
  options: { log?: Logger } = {},
): Promise<StartedGateway> {
  const log =
    options.log ??
    new Logger({
      level: config.logLevel,
      format: config.logFormat,
      sink: streamSink(process.stderr),
      bindings: { component: 'gateway' },
    });

  if (Object.keys(config.providers).length === 0) {
    throw new ConfigError(
      'No providers are configured. Set GATEWAY_PROVIDERS to a JSON object of provider configs.',
      { hint: 'See the gateway README for the exact shape.' },
    );
  }

  const store: UsageStore = config.database.enabled
    ? new PostgresUsageStore({
        connectionString: config.database.connectionString,
        maxConnections: config.database.maxConnections,
        statementTimeoutMs: config.database.statementTimeoutMs,
      })
    : new MemoryUsageStore();

  if (!config.database.enabled) {
    log.warn(
      'no GATEWAY_DATABASE_URL set: using the in-memory usage store — quotas are per-process and the ledger is lost on restart',
    );
  }

  await store.ready();

  const resolver = new ProviderResolver({ providers: config.providers, log });
  const { ready, failed } = await resolver.warm();
  if (ready.length === 0) {
    await store.close();
    throw new ConfigError(
      `No provider could be initialized (failed: ${failed.join(', ')}). Check the upstream credentials.`,
    );
  }
  if (failed.length > 0) {
    log.warn('some providers are unavailable and will return 502', { failed });
  }

  const catalogue = buildCatalogue({
    config: resolver.appConfig,
    pricing: config.pricing,
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  });
  if (catalogue.entries.length === 0) {
    await store.close();
    throw new ConfigError('No models are configured on any enabled provider.');
  }

  const deps: RouteDeps = {
    startedAt: Date.now(),
    config,
    catalogue,
    resolver,
    authenticator: new Authenticator({ apiKeys: config.apiKeys, log }),
    limiter: new QuotaLimiter({ limits: config.quota, store }),
    store,
    log,
  };

  const app = buildApp({ deps });

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const where =
    typeof address === 'object' && address !== null
      ? `${config.host}:${address.port}`
      : `${config.host}:${config.port}`;

  log.info('gateway listening', {
    version: VERSION,
    address: where,
    models: catalogue.entries.length,
    providers: ready,
    auth: deps.authenticator.enabled ? 'enabled' : 'DISABLED',
  });

  return {
    config,
    deps,
    address: where,
    async close(): Promise<void> {
      await app.close();
      await store.close();
    },
  };
}

/** Parse the environment, start the gateway, and install signal handlers. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // `--print-config` is the deployment debugging aid: it shows exactly what the
  // gateway parsed, with every secret reduced to its variable name.
  if (argv.includes('--print-config')) {
    const config = parseGatewayConfig();
    process.stdout.write(`${JSON.stringify(redactedConfig(config), null, 2)}\n`);
    return 0;
  }

  let started: StartedGateway;
  try {
    started = await startGateway(parseGatewayConfig());
  } catch (error) {
    const failure = toFreecodeError(error);
    process.stderr.write(`gateway failed to start: ${failure.message}\n`);
    if (failure.hint !== undefined) process.stderr.write(`  ${failure.hint}\n`);
    return failure.exitCode;
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    started.deps.log.info('shutting down', { signal });
    void started
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        process.stderr.write(`error during shutdown: ${String(error)}\n`);
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return 0;
}

/** A config safe to print: keys become variable names, never values. */
function redactedConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    ...config,
    apiKeys: config.apiKeys.map((_, index) => `<key ${index + 1}>`),
    database: {
      ...config.database,
      connectionString: config.database.enabled ? '<set>' : '<unset>',
    },
  };
}

// Run when invoked directly (`node dist/main.js`), but not when imported by a
// test. `import.meta.url` compared against argv[1] is the ESM-safe check.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`gateway crashed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
