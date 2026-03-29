#!/usr/bin/env node
/**
 * PostToolUse hook: syncs Claude's .md memory files into nan-forget Qdrant DB.
 *
 * When Claude writes/edits a file in a memory/ directory, this hook:
 * 1. Checks if the file is a memory .md file
 * 2. Parses the YAML frontmatter for type
 * 3. Calls nan-forget add to save it to Qdrant (long-term memory)
 * 4. On success, compresses the local file to a minimal stub
 *
 * Portable: works on macOS, Linux, Windows (Node.js, no bash dependencies).
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { basename } from 'path';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data?.tool_input?.file_path ?? '';

    // Only process memory .md files
    if (!filePath || !filePath.includes('/memory/') || !filePath.endsWith('.md')) {
      process.exit(0);
    }

    // Never compress MEMORY.md
    if (basename(filePath) === 'MEMORY.md') {
      process.exit(0);
    }

    // Read the file
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      process.exit(0);
    }

    // Skip already-compressed files
    if (content.includes('persisted: true')) {
      process.exit(0);
    }

    // Parse YAML frontmatter
    const parts = content.split('---');
    if (parts.length < 3) process.exit(0);

    const frontmatter = parts[1];
    const body = parts.slice(2).join('---').trim();
    if (!body) process.exit(0);

    // Extract type from frontmatter
    const typeMatch = frontmatter.match(/^type:\s*(.+)$/m);
    const rawType = typeMatch?.[1]?.trim() ?? 'fact';

    // Map Claude memory types to nan-forget types
    const typeMap = { user: 'fact', feedback: 'preference', project: 'context', reference: 'fact' };
    const nfType = typeMap[rawType] ?? 'fact';

    // Extract name for tags
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() ?? '';

    // Derive project from path
    let project = '_global';
    const projectMatch = filePath.match(/\/projects\/([^/]+)\//);
    if (projectMatch) {
      const segments = projectMatch[1].split('-');
      project = segments[segments.length - 1] || '_global';
    }

    // Truncate body
    const truncated = body.slice(0, 2000);

    // Tags
    const tags = ['auto-sync', 'claude-memory'];
    if (name) tags.push(name.slice(0, 50));

    // Save to nan-forget — compress local file on success
    execFile('npx', [
      'nan-forget', 'add', truncated,
      '--type', nfType,
      '--project', project,
      '--tags', tags.join(','),
    ], { timeout: 15000 }, (error) => {
      // On success: compress the local .md file to a stub
      if (!error && filePath.includes('.claude/') && filePath.includes('/memory/')) {
        try {
          const stub = `---\ntype: ${rawType}\npersisted: true\n---\nPersisted to nan-forget DB. Use memory_search to retrieve.\n`;
          writeFileSync(filePath, stub, 'utf-8');
        } catch {
          // Can't compress — leave original intact
        }
      }
    });

  } catch {
    // Silently fail — never block Claude
  }
  process.exit(0);
});
