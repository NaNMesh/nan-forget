#!/usr/bin/env node

// Thin wrapper that delegates to tsx for TypeScript execution.
// For production, use the compiled dist/ version instead.

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

try {
  execFileSync('npx', ['tsx', cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  process.exitCode = err.status ?? 1;
}
