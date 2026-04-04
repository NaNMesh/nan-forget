#!/usr/bin/env node
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

// Broader pattern matching — catch more context types
const PATTERNS = [
  // Decisions
  { pattern: /\b(decided|chose|switched to|went with|using .+ instead of|picked|selected|opted for|replaced .+ with)\b/i, type: 'decision' },
  // Preferences
  { pattern: /\b(prefer|always use|never use|convention is|style is|we follow|our approach)\b/i, type: 'preference' },
  // Facts (tech, architecture, config)
  { pattern: /\b(tech stack|framework|database|deploy|hosting|endpoint|configured|installed|set up|created .+ (file|table|index|schema|route|component))\b/i, type: 'fact' },
  // Bug fixes and problem-solutions
  { pattern: /\b(fixed|bug|root cause|the (issue|problem|error) was|resolved|patched|workaround)\b/i, type: 'fact' },
  // Tasks
  { pattern: /\b(TODO|need to|should|must|next step|blocked|remaining|still need|haven't done)\b/i, type: 'task' },
  // Context (current state)
  { pattern: /\b(working on|currently|in progress|building|implementing|migrating|refactoring)\b/i, type: 'context' },
  // Architecture
  { pattern: /\b(architecture|pattern|design|structure|schema|pipeline|workflow|approach)\b/i, type: 'fact' },
];

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tp = data?.transcript_path;
    if (!tp) process.exit(0);

    let lines;
    try {
      lines = readFileSync(tp, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { process.exit(0); }

    // Scan ALL assistant messages, not just last 20
    const msgs = lines.filter(l => l.role === 'assistant' && typeof l.content === 'string');
    const project = (data?.cwd ?? '').split('/').pop() || '_global';

    const toSave = [];
    const seen = new Set();

    for (const msg of msgs) {
      const sentences = (msg.content || '').split(/[.!?\n]/).filter(s => s.trim().length > 20 && s.trim().length < 500);
      for (const s of sentences) {
        const t = s.trim();
        for (const { pattern, type } of PATTERNS) {
          if (pattern.test(t) && !seen.has(t.slice(0, 60))) {
            seen.add(t.slice(0, 60));
            toSave.push({ content: t, type });
            break;
          }
        }
      }
    }

    // Save up to 15 (was 5) — nan-forget's writer deduplicates at 0.92 cosine,
    // so sending more is safe. Better to over-save than miss context.
    for (const item of toSave.slice(-15)) {
      try {
        execFileSync('npx', [
          'nan-forget', 'add',
          item.content,
          '--type', item.type,
          '--project', project,
          '--tags', 'auto-save,session-end',
        ], { timeout: 10000, stdio: 'ignore' });
      } catch {}
    }
  } catch {}
  process.exit(0);
});
