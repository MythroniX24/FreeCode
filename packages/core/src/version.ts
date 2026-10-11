/**
 * Single source of truth for the version reported by `--version`, `doctor`,
 * update checks and the gateway's `/health` endpoint.
 *
 * Kept as a literal (not read from package.json at runtime) so that the bundled
 * `dist/` output does not depend on package layout — important because the CLI
 * is executed directly via `node packages/cli/dist/index.js` during development.
 */
export const VERSION = '0.1.0';

/** Minimum Node.js major version required for structuredClone, fetch, AbortSignal.any. */
export const MIN_NODE_MAJOR = 20;
