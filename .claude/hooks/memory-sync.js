#!/usr/bin/env node
import { readFileSync } from 'fs';
import { execFile } from 'child_process';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data?.tool_input?.file_path ?? '';
    if (!filePath || !filePath.includes('/memory/') || !filePath.endsWith('.md')) process.exit(0);
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { process.exit(0); }
    const parts = content.split('---');
    if (parts.length < 3) process.exit(0);
    const frontmatter = parts[1];
    const body = parts.slice(2).join('---').trim();
    if (!body) process.exit(0);
    const typeMatch = frontmatter.match(/^type:\s*(.+)$/m);
    const rawType = typeMatch?.[1]?.trim() ?? 'fact';
    const typeMap = { user: 'fact', feedback: 'preference', project: 'context', reference: 'fact' };
    const nfType = typeMap[rawType] ?? 'fact';
    let project = '_global';
    const projectMatch = filePath.match(/\/projects\/([^/]+)\//);
    if (projectMatch) { const s = projectMatch[1].split('-'); project = s[s.length - 1] || '_global'; }
    execFile('npx', ['nan-forget', 'add', body.slice(0, 2000), '--type', nfType, '--project', project, '--tags', 'auto-sync,claude-memory'], { timeout: 15000 }, () => {});
  } catch {}
  process.exit(0);
});
