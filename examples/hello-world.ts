/**
 * Example: Hello World with FreeCode
 *
 * This is a simple example showing how to use the FreeCode CLI
 * to generate code from a natural language prompt.
 *
 * Run this example:
 *   node examples/hello-world.ts
 *
 * Or use the CLI directly:
 *   freecode run "Create a hello world TypeScript file"
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Set your API key (in a real app, use environment variables)
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Please set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// Run the FreeCode CLI
console.log('Generating a hello world TypeScript file...\n');

const prompt = `Create a simple TypeScript file that:
1. Defines a function called 'greet' that takes a name parameter
2. Returns a greeting message
3. Includes a main block that calls the function with "World" and logs the result
4. Uses proper TypeScript types`;

// Execute the CLI command
const command = `freecode run --provider anthropic --model claude-3-sonnet-20241022 "${prompt}"`;
console.log(`Running: ${command}\n`);

try {
  const output = execSync(command, {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('\nDone!');
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
}
