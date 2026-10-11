/**
 * `freecode doctor` — a read-only environment check.
 *
 * Reports *presence* of credentials, never the values. A provider shows as
 * "key: present (file)" / "key: present (keyring)" / "key: missing", and a
 * missing key is the actionable case. The command never reads `.env` files and
 * never prints a credential even when one is configured.
 *
 * `--json` output keeps the same discipline: credential fields are booleans and
 * provenance strings, never the secrets.
 */

import type { Command } from 'commander';

import type { CliContext } from '../context.js';
import { BUILT_IN_PROVIDERS, resolveApiKey } from '@freecode/core';

import { resolveCliContext } from '../util.js';

export function buildDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the environment and report configured credentials (never their values).')
    .option('-v, --verbose', 'show per-provider detail')
    .action(async (opts: { verbose?: boolean }) => {
      // Build the context here: without it `runDoctor` would see no config and
      // report every provider as "not configured", which is exactly the kind of
      // misleading output this command exists to avoid.
      const ctx = await resolveCliContext();
      await runDoctor({ ...opts, ctx });
    });
}

interface DoctorReport {
  node: string;
  configDir: string;
  cacheDir: string;
  providers: Array<{
    id: string;
    configured: boolean;
    keyPresent: boolean;
    keySource?: string;
  }>;
}

export async function runDoctor(options: { verbose?: boolean; ctx?: CliContext }): Promise<void> {
  const ctx = options.ctx;
  const report: DoctorReport = {
    node: process.version,
    configDir: '~/.config/freecode',
    cacheDir: '~/.cache/freecode',
    providers: [],
  };

  for (const builtIn of BUILT_IN_PROVIDERS) {
    // `configured` is whether config names this provider at all.
    const configured =
      (ctx?.config.config.providers?.[builtIn.id as string] ?? undefined) !== undefined;
    let keyPresent = false;
    let keySource: string | undefined;

    if (ctx !== undefined && configured) {
      // Resolve the key through the same path the factory uses; never echo it.
      const resolved = await resolveApiKey({
        providerId: builtIn.id,
        conventionalEnvVars: builtIn.apiKeyEnvVars,
        store: ctx.store,
      }).catch(() => undefined);
      if (resolved !== undefined) {
        keyPresent = true;
        keySource = resolved.source === 'store' ? 'store' : `env (${resolved.detail})`;
      }
    } else if (configured === false) {
      // Not configured — a doctor entry still notes the built-in exists.
      keyPresent = false;
    }

    report.providers.push({
      id: builtIn.id,
      configured,
      keyPresent,
      ...(keySource === undefined ? {} : { keySource }),
    });
  }

  if (options.verbose === true) {
    console.log(`node ${report.node}`);
    console.log(`config dir ${report.configDir}`);
    console.log(`cache dir  ${report.cacheDir}`);
    for (const provider of report.providers) {
      console.log(
        `${provider.id.padEnd(12)} configured=${provider.configured ? 'yes' : 'no'} key=${provider.keyPresent ? 'present' : 'missing'}${provider.keySource === undefined ? '' : ` (${provider.keySource})`}`,
      );
    }
  } else {
    const missing = report.providers.filter((p) => p.configured && !p.keyPresent);
    const configured = report.providers.filter((p) => p.configured);
    for (const provider of report.providers) {
      console.log(
        `  ${provider.id.padEnd(12)} ${provider.keyPresent ? '✓ key present' : '· key missing'}${provider.configured ? '' : '  (not configured)'}`,
      );
    }
    if (missing.length > 0) {
      console.log('Missing keys: use `freecode auth login <provider>` to set one.');
    } else if (configured.length === 0) {
      console.log('No providers configured yet. Use `freecode providers add <id>` to enable one.');
    } else {
      console.log('All configured providers have a key.');
    }
  }
}
