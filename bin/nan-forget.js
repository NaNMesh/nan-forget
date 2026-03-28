#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compiled = resolve(__dirname, '..', 'dist', 'cli', 'index.js');
const src = resolve(__dirname, '..', 'src', 'cli', 'index.ts');

if (existsSync(compiled)) {
  // Production: use compiled JS directly
  const { run } = await import(compiled);
  await run();
} else if (existsSync(src)) {
  // Development: use tsx for TypeScript
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('npx', ['tsx', src, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    process.exitCode = err.status ?? 1;
  }
} else {
  console.error('Error: nan-forget not properly installed. Run: npm install -g nan-forget');
  process.exitCode = 1;
}
