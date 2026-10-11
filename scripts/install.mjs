#!/usr/bin/env node
/**
 * Local installation script for FreeCode CLI.
 *
 * Usage:
 *   node scripts/install.mjs          # Build and link globally
 *   node scripts/install.mjs --local  # Build and link in current directory
 *   node scripts/install.mjs --unlink # Unlink global installation
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function run(cmd, cwd = rootDir) {
  console.log(`Running: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd });
  } catch (error) {
    console.error(`Error: ${cmd} failed`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const unlink = args.includes('--unlink');
  const localOnly = args.includes('--local');

  if (unlink) {
    console.log('Unlinking global freecode...');
    run('npm unlink -g freecode', rootDir);
    console.log('Done!');
    return;
  }

  console.log('Installing FreeCode CLI...\n');

  // Step 1: Install dependencies
  console.log('Step 1: Installing dependencies...');
  run('npm install');

  // Step 2: Build all packages
  console.log('\nStep 2: Building all packages...');
  run('npm run build');

  if (localOnly) {
    // Local link only
    console.log('\nStep 3: Linking CLI locally...');
    run('cd packages/cli && npm link', path.join(rootDir, 'packages/cli'));
    console.log('\n✅ FreeCode CLI is now linked locally!');
    console.log('   You can run it with: npx freecode run "your prompt"');
  } else {
    // Global installation
    console.log('\nStep 3: Linking CLI globally...');
    run('cd packages/cli && npm link', path.join(rootDir, 'packages/cli'));

    // Also create a symlink in /usr/local/bin if possible
    const globalNodeModules = path.join(
      execSync('npm root -g', { encoding: 'utf8' }).trim(),
      '..',
      'bin'
    );

    if (existsSync(globalNodeModules)) {
      const target = path.join(rootDir, 'packages/cli/dist/index.js');
      const linkPath = path.join(globalNodeModules, 'freecode');

      try {
        execSync(`ln -sf "${target}" "${linkPath}"`, { stdio: 'inherit' });
        console.log('   Created symlink in global bin directory');
      } catch {
        // Symlink might already exist or permission issue
        console.log('   (Could not create global symlink, using npm link)');
      }
    }

    console.log('\n✅ FreeCode CLI is now installed globally!');
    console.log('   You can run it with: freecode run "your prompt"');
  }

  console.log('\nTo uninstall:');
  console.log('   node scripts/install.mjs --unlink');
}

main();
