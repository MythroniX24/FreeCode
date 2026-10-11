/**
 * `freecode models` — discover and query the model registry.
 *
 * `list` reads the union of cached and config-pinned models (never inventing
 * ids), optionally filtered by provider and search substring. `refresh` runs a
 * live discovery against every enabled provider, writes the cache, and reports
 * failures per-provider — a provider that is unreachable is listed as failed,
 * not silently dropped.
 */

import type { Command } from 'commander';

import {
  configuredModelIds,
  discoverProviders,
  identifyModel,
  pickRoute,
  queryRegistry,
  unionRegistry,
} from '@freecode/core';

import type { CliContext } from '../context.js';
import { resolveCliContext } from '../util.js';

export function buildModelCommands(program: Command): void {
  const models = program.command('models').description('Discover and query available models.');

  models
    .command('list')
    .description(
      'List models from the cache and config pins; supply filters to narrow. No network.',
    )
    .option('-p, --provider <id>', 'only list models from this provider')
    .option('-s, --search <text>', 'only list models whose id contains this text')
    .option('--fresh', 'refresh the cache before listing')
    .action(async (opts: { provider?: string; search?: string; fresh?: boolean }) => {
      const ctx = await resolveCliContext();
      if (opts.fresh === true) {
        await runRefresh(ctx);
      }
      await runList(ctx, opts);
    });

  models
    .command('refresh')
    .description('Refresh the model registry from every enabled provider, then list the result.')
    .action(async () => {
      const ctx = await resolveCliContext();
      await runRefresh(ctx);
      await runList(ctx, {});
    });

  models
    .command('which <model>')
    .description(
      'Resolve a model reference: report which provider a bare id belongs to, and the routed chain.',
    )
    .option('-p, --provider <id>', 'hint the provider for a bare model id')
    .option('--explain', 'print the per-dimension routing scores')
    .action(async (model: string, opts: { provider?: string; explain?: boolean }) => {
      const ctx = await resolveCliContext();
      await runWhich(ctx, model, opts);
    });
}

export async function runRefresh(ctx: CliContext): Promise<void> {
  const results = await discoverProviders({
    config: ctx.config.config,
    store: ctx.store,
    log: ctx.logger,
  });
  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    if (result.ok) {
      const origin = result.fromCache ? 'cache' : 'live';
      console.log(
        `✓ ${result.providerId}: ${result.modelIds.length} model${result.modelIds.length === 1 ? '' : 's'} (${origin})`,
      );
    } else {
      // A provider that failed is reported as failed, never silently dropped.
      console.log(`✗ ${result.providerId}: ${result.error ?? 'unknown error'}`);
    }
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

export async function runList(
  ctx: CliContext,
  options: { provider?: string; search?: string } = {},
): Promise<void> {
  const rows = await unionRegistry({
    configuredFor: configuredModelIds(ctx.config.config),
  });
  const filtered = queryRegistry(rows, {
    ...(options.provider === undefined ? {} : { providerId: options.provider }),
    ...(options.search === undefined ? {} : { search: options.search }),
  });
  if (filtered.length === 0) {
    console.log(
      'No models found. Run “freecode models refresh” to discover live models, or pin some in config.',
    );
    return;
  }
  for (const row of filtered) {
    console.log(`  ${row.reference.padEnd(48)} ${row.source}`);
  }
}

/**
 * `models which <model>` — resolve a model reference.
 *
 * Stealth identification promise: a bare id is reported as belonging to a
 * provider only when that is *known* (registry match, a single config pin, or a
 * documented catalogue prefix for a configured provider). Anything else prints
 * "provider not identified" rather than a guess. When a route can be selected,
 * the routed chain is shown, and `--explain` adds the per-dimension scores.
 */
export async function runWhich(
  ctx: CliContext,
  model: string,
  options: { provider?: string; explain?: boolean } = {},
): Promise<void> {
  const config = ctx.config.config;
  const slash = model.indexOf('/');
  const hasProvider = slash > 0;

  if (!hasProvider) {
    const rows = await unionRegistry({ configuredFor: configuredModelIds(config) });
    const identified = identifyModel(model, { config, rows });
    console.log(
      identified.basis === undefined
        ? `provider not identified for “${model}”`
        : `“${model}” → ${identified.providerId} (${identified.basis})`,
    );
  }

  const decision = await pickRoute({
    config,
    rows: await unionRegistry({ configuredFor: configuredModelIds(config) }),
    log: ctx.logger,
    store: ctx.store,
    ...(options.provider === undefined ? {} : { explicitProvider: options.provider }),
  });
  if (decision.chosen === undefined) {
    console.log(decision.emptyReason ?? 'No route.');
    return;
  }
  // Without `--explain`: one line per chain entry, with the source, billing and
  // score. The bare `provider/model` answer is the primary route's reference.
  if (!options.explain) {
    for (const candidate of decision.chain) {
      console.log(`  ${candidate.reference.padEnd(48)} ${candidate.source} [${candidate.billing}]`);
    }
    return;
  }
  for (const line of decision.explanation) {
    console.log(line);
  }
}
