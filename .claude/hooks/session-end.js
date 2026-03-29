#!/usr/bin/env node
/**
 * SessionEnd hook: extracts the session recap from the final assistant messages
 * and saves it as a single cohesive context memory.
 *
 * Strategy: Claude often ends sessions with a recap/summary. We extract the
 * LAST substantial assistant message and save it as context. This captures
 * the AI's own understanding of what was accomplished, not regex fragments.
 *
 * Falls back to extracting key decisions/tasks if no clear recap exists.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const transcriptPath = data?.transcript_path;
    if (!transcriptPath) process.exit(0);

    // Read transcript (JSONL format)
    let lines;
    try {
      lines = readFileSync(transcriptPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      process.exit(0);
    }

    // Get assistant messages with actual content
    const assistantMessages = lines
      .filter(l => l.role === 'assistant' && typeof l.content === 'string' && l.content.length > 50)
      .map(l => l.content);

    if (assistantMessages.length === 0) process.exit(0);

    // Derive project from cwd
    const cwd = data?.cwd ?? '';
    const project = cwd.split('/').pop() || '_global';

    // Strategy 1: Last substantial message (often the session recap)
    const lastMsg = assistantMessages[assistantMessages.length - 1];

    // If last message is substantial (>200 chars), it's likely a recap
    if (lastMsg.length > 200) {
      // Take up to 1500 chars of the last message as session context
      const recap = lastMsg.slice(0, 1500).trim();

      // Extract concepts from the recap
      const conceptPatterns = [
        /\b(auth|authentication|authorization)\b/i,
        /\b(deploy|deployment|hosting|ci\/cd)\b/i,
        /\b(database|db|sql|nosql|qdrant|postgres)\b/i,
        /\b(api|endpoint|rest|graphql)\b/i,
        /\b(test|testing|jest|vitest)\b/i,
        /\b(docker|container|kubernetes)\b/i,
        /\b(cache|redis|memcache)\b/i,
        /\b(webpack|vite|build|bundle)\b/i,
        /\b(react|vue|angular|svelte|next)\b/i,
        /\b(node|python|rust|go|java)\b/i,
        /\b(security|cors|csrf|xss)\b/i,
        /\b(performance|optimization|speed)\b/i,
        /\b(memory|qdrant|embedding|vector)\b/i,
        /\b(hook|middleware|plugin)\b/i,
        /\b(migration|upgrade|version)\b/i,
      ];

      const concepts = [];
      for (const { source } of conceptPatterns.map(p => ({ source: p.source, match: p.test(recap) }))) {
        // Extract the first word from the pattern
      }
      const foundConcepts = conceptPatterns
        .filter(p => p.test(recap))
        .map(p => {
          const m = recap.match(p);
          return m ? m[0].toLowerCase() : null;
        })
        .filter(Boolean)
        .slice(0, 5);

      try {
        const conceptsArg = foundConcepts.length > 0 ? foundConcepts.join(',') : 'session-recap';
        execFileSync('npx', [
          'nan-forget', 'add', recap,
          '--type', 'context',
          '--project', project,
          '--tags', `auto-save,session-end,${conceptsArg}`,
        ], { timeout: 15000, stdio: 'ignore' });
      } catch {
        // Don't block session exit
      }
    }

    // Strategy 2: Also extract any explicit decisions (short, targeted saves)
    const decisionPatterns = [
      { pattern: /\b(decided|chose|switched to|went with)\b/i, type: 'decision' },
      { pattern: /\b(TODO|need to|must|blocked|next step)\b/i, type: 'task' },
    ];

    const decisions = [];
    const seen = new Set();

    // Only scan last 5 messages for key decisions
    for (const msg of assistantMessages.slice(-5)) {
      const sentences = msg.split(/[.!?\n]/).filter(s => s.trim().length > 20 && s.trim().length < 300);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        for (const { pattern, type } of decisionPatterns) {
          if (pattern.test(trimmed) && !seen.has(trimmed.slice(0, 40))) {
            seen.add(trimmed.slice(0, 40));
            decisions.push({ content: trimmed, type });
            break;
          }
        }
      }
    }

    // Save top 3 decisions (not 5 — keep it lean)
    for (const item of decisions.slice(-3)) {
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
