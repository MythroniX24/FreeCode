/**
 * `freecode providers` — inspect and configure providers.
 *
 * `list` renders the built-in catalogue with its billing provenance, never a
 * fabricated price. `add` writes a provider block into the user config — as a
 * config edit, so the "never wallet-bypass" rule is preserved by keeping the
 * API key out of config entirely. `check` resolves a provider's adapter against
 * the configured base URL, exercising the real factory path (but not the
 * network, which `freecode models refresh` covers).
 */

import type { Command } from 'commander';

import { BUILT_IN_PROVIDERS, createProvider, setAtPath, UsageError } from '@freecode/core';

import type { CliContext } from '../context.js';
import { resolveCliContext } from '../util.js';
import { readUserConfig, writeUserConfig } from '../userconfig.js';

export function buildProviderCommands(program: Command): void {
  const providers = program
    .command('providers')
    .description('Inspect and configure model providers.');

  providers
    .command('list')
    .description('List the built-in provider catalogue with billing provenance (never prices).')
    .action(async () => {
      const ctx = await resolveCliContext();
      await runList(ctx);
    });

  providers
    .command('add <id>')
    .description(
      'Enable a provider by writing its config block; the key is set separately via `auth login`.',
    )
    .action(async (providerId: string) => {
      const ctx = await resolveCliContext();
      await runAdd(ctx, providerId);
    });

  providers
    .command('check <id>')
    .description('Resolve a provider’s adapter and base URL (no network).')
    .action(async (providerId: string) => {
      const ctx = await resolveCliContext();
      await runCheck(ctx, providerId);
    });
}

export async function runList(ctx: CliContext): Promise<void> {
  const configured = new Set(Object.keys(ctx.config.config.providers ?? {}));
  console.log('Providers (billing is provenance, never a charge):');
  for (const entry of BUILT_IN_PROVIDERS) {
    const enabled = configured.has(entry.id);
    const marker = enabled ? '✓' : ' ';
    console.log(
      `  ${marker} ${entry.id.padEnd(16)} ${entry.name.padEnd(22)} ${entry.billing.padEnd(10)} ${entry.requiresApiKey ? 'key' : 'keyless'}`,
    );
    if (entry.notes !== undefined) {
      console.log(`      ↳ ${entry.notes}`);
    }
  }
}

export async function runAdd(ctx: CliContext, providerId: string): Promise<void> {
  const entry = BUILT_IN_PROVIDERS.find((p) => p.id === providerId);
  if (entry === undefined) {
    throw new UsageError(`Unknown provider “${providerId}”.`, {
      hint: 'The built-in ids are: ' + BUILT_IN_PROVIDERS.map((p) => p.id).join(', ') + '.',
    });
  }
  const config = ctx.config.config;
  const existing = config.providers?.[providerId];
  if (existing !== undefined && existing.enabled) {
    console.log(`Provider ${providerId} is already enabled.`);
    return;
  }

  // Patch the *raw* user config file rather than the resolved config: writing
  // the resolved object back would expand the file with every default. The raw
  // object is the source of truth for what the user authored.
  const raw = (await readUserConfig()) as Record<string, unknown>;
  const providers = (raw['providers'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const block: Record<string, unknown> = providers[providerId] ?? {};
  setAtPath(raw, `providers.${providerId}`, {
    ...block,
    enabled: true,
    type: entry.adapter,
    baseUrl: entry.defaultBaseUrl,
    billing: entry.billing,
  });
  await writeUserConfig(raw);
  console.log(`✓ Enabled ${providerId} (${entry.name}).`);
  console.log(
    `  Set an API key with “freecode auth login ${providerId}”${entry.requiresApiKey ? '' : ' (not required)'}.`,
  );
}

export async function runCheck(ctx: CliContext, providerId: string): Promise<void> {
  // Exercising the real factory path surfaces config errors (disabled type,
  // missing key) exactly as the runtime would. The key is never printed.
  const { baseUrl } = await createProvider(providerId, {
    config: ctx.config.config,
    store: ctx.store,
    log: ctx.logger,
  });
  console.log(`${providerId}: base URL ${baseUrl}`);
}
