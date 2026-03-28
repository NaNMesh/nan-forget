#!/usr/bin/env node
/**
 * SessionEnd hook: extracts key learnings from the conversation transcript
 * and saves them to nan-forget before the session closes.
 *
 * Reads the transcript JSONL file, scans the last N assistant messages for
 * decisions, preferences, facts, and context, then saves each to Qdrant.
 *
 * This is the safety net — catches anything Claude learned but didn't
 * explicitly call memory_save for during the session.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

// Patterns that indicate something worth saving
const SAVE_PATTERNS = [
  { pattern: /\b(decided|chose|switched to|went with|using .+ instead of|picked)\b/i, type: 'decision' },
  { pattern: /\b(prefer|always use|never use|like to|rather|convention is)\b/i, type: 'preference' },
  { pattern: /\b(tech stack|framework|database|deploy|hosting|API key|endpoint|port)\b/i, type: 'fact' },
  { pattern: /\b(TODO|need to|should|must|have to|next step|follow up|blocked)\b/i, type: 'task' },
  { pattern: /\b(working on|currently|in progress|started|building|implementing)\b/i, type: 'context' },
];

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const transcriptPath = data?.transcript_path;
    if (!transcriptPath) process.exit(0);

    // Read transcript (JSONL format — one JSON object per line)
    let lines;
    try {
      lines = readFileSync(transcriptPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      process.exit(0);
    }

    // Get last 20 assistant messages
    const assistantMessages = lines
      .filter(l => l.role === 'assistant' && typeof l.content === 'string')
      .slice(-20);

    if (assistantMessages.length === 0) process.exit(0);

    // Derive project from cwd
    const cwd = data?.cwd ?? '';
    const project = cwd.split('/').pop() || '_global';

    // Scan for saveable content
    const toSave = [];
    const seen = new Set();

    for (const msg of assistantMessages) {
      const content = msg.content;
      if (!content || content.length < 20) continue;

      // Split into sentences
      const sentences = content.split(/[.!?\n]/).filter(s => s.trim().length > 15);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length > 500) continue; // Skip long blocks (code, etc.)

        for (const { pattern, type } of SAVE_PATTERNS) {
          if (pattern.test(trimmed) && !seen.has(trimmed.slice(0, 50))) {
            seen.add(trimmed.slice(0, 50));
            toSave.push({ content: trimmed, type });
            break; // One match per sentence
          }
        }
      }
    }

    // Save top 5 (don't overwhelm the DB with noise)
    const batch = toSave.slice(-5);
    for (const item of batch) {
      try {
        execFileSync('npx', [
          'nan-forget', 'add', item.content,
          '--type', item.type,
          '--project', project,
          '--tags', 'auto-save,session-end',
        ], { timeout: 10000, stdio: 'ignore' });
      } catch {
        // Don't block session exit
      }
    }

  } catch {
    // Silently fail — never block session exit
  }
  process.exit(0);
});
