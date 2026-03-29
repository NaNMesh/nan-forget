#!/usr/bin/env node
/**
 * NaN Forget MCP Server
 *
 * 13 tools: memory_save, memory_search, memory_get, memory_update, memory_archive,
 *           memory_consolidate, memory_clean, memory_stats, memory_health, memory_start, memory_sync,
 *           memory_checkpoint, memory_compress
 * Runs over stdio. Connects to local Qdrant.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createQdrantClient, ensureCollection, getMemory, updateMemory, scrollMemories, searchMemories } from '../qdrant.js';
import { checkHealth, startAll } from '../services.js';
import { createEmbedder } from '../embeddings.js';
import { writeMemory } from '../writer.js';
import { retrieve } from '../retriever.js';
import { clean } from '../cleaner.js';
import { consolidate } from '../consolidator.js';
import {
  read as readMemoryMd,
  write as writeMemoryMd,
  addLine,
} from '../memory-md.js';
import type { MemoryType } from '../types.js';

// --- Auto-consolidate state ---
let savesSinceConsolidate = 0;
let lastConsolidateAt = Date.now();

// --- Config from env ---

const QDRANT_URL = process.env.NAN_FORGET_QDRANT_URL ?? 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
// Auto-detect: use OpenAI if key exists, otherwise Ollama (free, local)
const EMBEDDING_PROVIDER = (
  process.env.NAN_FORGET_EMBEDDING_PROVIDER ??
  (OPENAI_API_KEY ? 'openai' : 'ollama')
) as 'openai' | 'ollama';
const USER_ID = process.env.NAN_FORGET_USER_ID ?? 'default';
const PROJECT_ROOT = process.env.NAN_FORGET_PROJECT_ROOT ?? process.cwd();

// --- Init ---

export interface ServerDeps {
  client?: ReturnType<typeof createQdrantClient>;
  embedder?: ReturnType<typeof createEmbedder>;
  userId?: string;
  projectRoot?: string;
}

export function createServer(deps?: ServerDeps) {
  const client = deps?.client ?? createQdrantClient(QDRANT_URL);
  const embedder = deps?.embedder ?? createEmbedder({
    provider: EMBEDDING_PROVIDER,
    openaiApiKey: OPENAI_API_KEY,
  });
  const userId = deps?.userId ?? USER_ID;
  const projectRoot = deps?.projectRoot ?? PROJECT_ROOT;

  const server = new McpServer({
    name: 'nan-forget',
    version: '0.5.0',
  });

  // ═══════════════════════════════════════
  // Tool 1: memory_save
  // ═══════════════════════════════════════
  server.tool(
    'memory_save',
    'IMPORTANT: You MUST call this tool proactively whenever you learn a decision, preference, fact, or context worth remembering across sessions. Do NOT wait for the user to ask you to save — save immediately as you learn it. Include structured fields (problem/solution/concepts) when relevant — these make memories more searchable and useful in future sessions. Deduplicates automatically — safe to call even if it might already exist.',
    {
      content: z.string().describe('The full text of the memory — include reasoning, context, and key details'),
      type: z.enum(['fact', 'decision', 'preference', 'task', 'context']).describe('Memory type'),
      project: z.string().describe('Project name this memory belongs to'),
      tags: z.array(z.string()).optional().describe('Optional tags for filtering'),
      problem: z.string().optional().describe('What was the problem, question, or challenge? (makes search much better)'),
      solution: z.string().optional().describe('How was it solved? What was the answer or approach?'),
      files: z.array(z.string()).optional().describe('Files involved (e.g. ["src/auth.ts", "config.yaml"])'),
      concepts: z.array(z.string()).optional().describe('Key concepts for searchability (e.g. ["auth", "jwt", "middleware"])'),
    },
    async ({ content, type, project, tags, problem, solution, files, concepts }) => {
      await ensureCollection(client, embedder.provider);

      const result = await writeMemory(client, embedder, {
        content,
        type: type as MemoryType,
        project,
        tags,
        user_id: userId,
        problem,
        solution,
        files,
        concepts,
      });

      // Also add to MEMORY.md
      if (!result.deduplicated) {
        const mem = await getMemory(client, result.id);
        if (mem) {
          let state = await readMemoryMd(projectRoot);
          state = addLine(state, {
            type: mem.type,
            summary: mem.summary,
            engram_id: mem.id,
            project: mem.project,
          });
          await writeMemoryMd(state, projectRoot);
        }
      }

      // Auto-consolidate check
      savesSinceConsolidate++;
      const hoursSinceClean = (Date.now() - lastConsolidateAt) / (1000 * 60 * 60);
      if (savesSinceConsolidate >= 10 || hoursSinceClean >= 24) {
        savesSinceConsolidate = 0;
        lastConsolidateAt = Date.now();
        // Fire and forget — non-blocking
        consolidate(client, embedder, userId, { project_root: projectRoot })
          .then(() => clean(client, embedder, userId, { project_root: projectRoot }))
          .then(() => console.error('Auto-consolidate + clean completed'))
          .catch((err) => console.error('Auto-consolidate failed:', err));
      }

      return {
        content: [{
          type: 'text' as const,
          text: result.deduplicated
            ? `Memory already exists (dedup match). Updated existing: ${result.id}`
            : `Memory saved: ${result.id}`,
        }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 2: memory_search
  // ═══════════════════════════════════════
  server.tool(
    'memory_search',
    'IMPORTANT: Call this DURING the conversation whenever you encounter a topic that may have prior context — auth, deployment, testing, architecture, tooling, etc. Do NOT wait for the user to ask. If the topic might have been discussed in any past session or project, search for it. Searches across ALL projects automatically — decisions from Project A surface in Project B. This is your long-term memory. Use it like you would use your own recall. Depth 1 = summaries, depth 2 = full content, depth 3 = full + associated memories.',
    {
      query: z.string().describe('What you want to remember — a question or topic'),
      project: z.string().optional().describe('Limit search to a specific project'),
      depth: z.number().min(1).max(3).optional().describe('Search depth: 1=blur, 2=clarity, 3=association. Default 2.'),
    },
    async ({ query, project, depth }) => {
      await ensureCollection(client, embedder.provider);

      const maxStage = (depth ?? 2) as 1 | 2 | 3;
      const result = await retrieve(client, embedder, query, {
        user_id: userId,
        project,
      }, { maxStage, limit: 5 });

      const parts: string[] = [];

      if (result.recognition.length > 0 && maxStage === 1) {
        parts.push('## Recognition (blur)\n');
        for (const r of result.recognition) {
          parts.push(`- [${r.type}] ${r.summary} (score: ${r.adjusted_score.toFixed(3)}, id: ${r.id})`);
        }
      }

      if (result.recall.length > 0) {
        parts.push('## Memories\n');
        for (const r of result.recall) {
          parts.push(`### ${r.memory.summary} (${r.memory.type})`);
          parts.push(`> ${r.memory.content}`);
          if (r.memory.problem) parts.push(`**Problem:** ${r.memory.problem}`);
          if (r.memory.solution) parts.push(`**Solution:** ${r.memory.solution}`);
          if (r.memory.files?.length) parts.push(`**Files:** ${r.memory.files.join(', ')}`);
          if (r.memory.concepts?.length) parts.push(`**Concepts:** ${r.memory.concepts.join(', ')}`);
          parts.push(`score: ${r.adjusted_score.toFixed(3)} | project: ${r.memory.project} | tags: ${(r.memory.tags ?? []).join(', ')} | id: ${r.memory.id}`);
          parts.push('');
        }
      }

      if (result.associations.length > 0) {
        parts.push('## Associated Memories\n');
        for (const a of result.associations) {
          parts.push(`- [${a.memory.type}] ${a.memory.summary} (score: ${a.score.toFixed(3)}, id: ${a.memory.id})`);
        }
      }

      if (parts.length === 0) {
        parts.push('No memories found for this query.');
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 3: memory_get
  // ═══════════════════════════════════════
  server.tool(
    'memory_get',
    'Get a specific memory by its ID. Use when you have a memory ID from search results and need the full content.',
    {
      id: z.string().describe('Memory ID'),
    },
    async ({ id }) => {
      const mem = await getMemory(client, id);
      if (!mem) {
        return {
          content: [{ type: 'text' as const, text: `Memory not found: ${id}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(mem, null, 2),
        }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 4: memory_update
  // ═══════════════════════════════════════
  server.tool(
    'memory_update',
    'Update an existing memory. Use to correct, refine, or add tags to a memory.',
    {
      id: z.string().describe('Memory ID to update'),
      content: z.string().optional().describe('New content (replaces old)'),
      type: z.enum(['fact', 'decision', 'preference', 'task', 'context']).optional().describe('New type'),
      tags: z.array(z.string()).optional().describe('New tags (replaces old)'),
    },
    async ({ id, content, type, tags }) => {
      const existing = await getMemory(client, id);
      if (!existing) {
        return {
          content: [{ type: 'text' as const, text: `Memory not found: ${id}` }],
          isError: true,
        };
      }

      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (content !== undefined) updates.content = content;
      if (type !== undefined) updates.type = type;
      if (tags !== undefined) updates.tags = tags;

      await updateMemory(client, id, updates);

      return {
        content: [{ type: 'text' as const, text: `Memory updated: ${id}` }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 5: memory_archive
  // ═══════════════════════════════════════
  server.tool(
    'memory_archive',
    'Archive a memory (soft delete). The memory is never truly deleted — just hidden from search. Use when a decision is reversed or information is outdated.',
    {
      id: z.string().describe('Memory ID to archive'),
    },
    async ({ id }) => {
      const existing = await getMemory(client, id);
      if (!existing) {
        return {
          content: [{ type: 'text' as const, text: `Memory not found: ${id}` }],
          isError: true,
        };
      }

      await updateMemory(client, id, {
        status: 'archived',
        updated_at: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text' as const, text: `Memory archived: ${id}` }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 6: memory_consolidate
  // ═══════════════════════════════════════
  server.tool(
    'memory_consolidate',
    'Consolidate aging memories into compact long-term entries. Clusters related memories by topic, summarizes them (LLM if available, deterministic fallback), and creates new searchable entries. Original memories are archived. Run this periodically or let it happen automatically after every 10 saves.',
    {
      project: z.string().optional().describe('Limit consolidation to a specific project'),
    },
    async ({ project }) => {
      await ensureCollection(client, embedder.provider);

      const result = await consolidate(client, embedder, userId, {
        project,
        project_root: projectRoot,
      });

      return {
        content: [{
          type: 'text' as const,
          text: [
            'Consolidation complete:',
            `  Clusters found:        ${result.clusters_found}`,
            `  Memories consolidated:  ${result.memories_consolidated}`,
            `  New entries created:    ${result.new_memories_created}`,
            `  Duration:              ${result.duration_ms}ms`,
          ].join('\n'),
        }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 7: memory_clean
  // ═══════════════════════════════════════
  server.tool(
    'memory_clean',
    'Run garbage collection on memories. Archives decayed (unused) memories, removes expired ones, deduplicates near-identical entries, and syncs MEMORY.md. Use after consolidation or when memory feels cluttered.',
    {},
    async () => {
      await ensureCollection(client, embedder.provider);

      const result = await clean(client, embedder, userId, {
        project_root: projectRoot,
      });

      return {
        content: [{
          type: 'text' as const,
          text: [
            'Clean complete:',
            `  Archived (decayed):  ${result.archived_decayed}`,
            `  Archived (expired):  ${result.archived_expired}`,
            `  Archived (deduped):  ${result.archived_deduped}`,
            `  MEMORY.md synced:    ${result.memory_md_synced}`,
            `  Duration:            ${result.duration_ms}ms`,
          ].join('\n'),
        }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 8: memory_stats
  // ═══════════════════════════════════════
  server.tool(
    'memory_stats',
    'Show memory statistics: active/archived counts, breakdown by type and project. Use to check memory health and understand what you remember.',
    {},
    async () => {
      const active = await scrollMemories(client, { user_id: userId, status: 'active' }, 1000);
      const archived = await scrollMemories(client, { user_id: userId, status: 'archived' }, 1000);

      const byType: Record<string, number> = {};
      const byProject: Record<string, number> = {};
      let consolidatedCount = 0;
      for (const m of active) {
        byType[m.type] = (byType[m.type] ?? 0) + 1;
        byProject[m.project] = (byProject[m.project] ?? 0) + 1;
        if (m.consolidated_from?.length) consolidatedCount++;
      }

      const lines = [
        'NaN Forget — Memory Stats',
        '',
        `Active:       ${active.length}`,
        `Archived:     ${archived.length}`,
        `Consolidated: ${consolidatedCount}`,
        `Total:        ${active.length + archived.length}`,
        '',
        'By type:',
        ...Object.entries(byType).map(([t, c]) => `  ${t}: ${c}`),
        '',
        'By project:',
        ...Object.entries(byProject).map(([p, c]) => `  ${p}: ${c}`),
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 9: memory_health
  // ═══════════════════════════════════════
  server.tool(
    'memory_health',
    'Check if nan-forget services are running (Qdrant, Ollama, REST API). Call this at the start of each session to verify everything is ready. If services are down, ask the user if they want to start them, then call memory_start.',
    {},
    async () => {
      const status = await checkHealth();
      const lines = [
        'NaN Forget — Service Health',
        '',
        `Qdrant:   ${status.qdrant ? '✓ running' : '✗ down'}`,
        `Ollama:   ${status.ollama ? '✓ running' : '✗ down'}`,
        `REST API: ${status.api ? '✓ running' : '✗ down'}`,
      ];

      const allUp = status.qdrant && status.ollama && status.api;
      if (!allUp) {
        lines.push('', 'Some services are down. Ask the user if they want to start them, then call memory_start.');
      } else {
        lines.push('', 'All services healthy. Memory system ready.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 10: memory_start
  // ═══════════════════════════════════════
  server.tool(
    'memory_start',
    'Start all nan-forget services (Qdrant, Ollama, REST API). Only call this after the user confirms they want services started. Starts Docker containers, Ollama, and the REST API.',
    {},
    async () => {
      const result = await startAll();

      const lines = [
        'NaN Forget — Starting Services',
        '',
        `Qdrant:   ${result.qdrant.started ? '✓ started' : '✗ ' + (result.qdrant.error ?? 'failed')}`,
        `Ollama:   ${result.ollama.started ? '✓ started' : '✗ ' + (result.ollama.error ?? 'failed')}`,
        `REST API: ${result.api.started ? '✓ started' : '✗ ' + (result.api.error ?? 'failed')}`,
      ];

      const allUp = result.qdrant.started && result.ollama.started && result.api.started;
      if (allUp) {
        lines.push('', 'All services running. Memory system ready.');
      } else {
        lines.push('', 'Some services failed to start. Check the errors above.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 11: memory_sync
  // ═══════════════════════════════════════
  server.tool(
    'memory_sync',
    'IMPORTANT: Call this ONCE at the start of every session. Lightweight handshake — checks if services are running, reports how many memories are available, and shows recent memory summaries so you know what context exists. If services are down, ask the user to start them via memory_start.',
    {},
    async () => {
      await ensureCollection(client, embedder.provider);

      const parts: string[] = ['# NaN Forget — Ready\n'];

      // 1. Health check
      const health = await checkHealth();
      const allUp = health.qdrant && (health.ollama || !!OPENAI_API_KEY);
      parts.push(`## Services`);
      parts.push(`Qdrant: ${health.qdrant ? '✓' : '✗'} | Ollama: ${health.ollama ? '✓' : '✗'} | API: ${health.api ? '✓' : '✗'}`);
      if (!allUp) {
        parts.push('\nSome services are down. Ask the user if they want to start them, then call memory_start.');
      }
      parts.push('');

      // 2. Stats (lightweight — just counts)
      const active = await scrollMemories(client, { user_id: userId, status: 'active' }, 1000);
      const byProject: Record<string, number> = {};
      for (const m of active) {
        byProject[m.project] = (byProject[m.project] ?? 0) + 1;
      }
      parts.push(`## Memory Bank`);
      parts.push(`${active.length} active memories across ${Object.keys(byProject).length} project(s)`);
      if (Object.keys(byProject).length > 0) {
        parts.push('Projects: ' + Object.entries(byProject).map(([p, c]) => `${p} (${c})`).join(', '));
      }
      parts.push('');

      // 3. Auto-consolidate if needed (background, non-blocking)
      const hoursSinceClean = (Date.now() - lastConsolidateAt) / (1000 * 60 * 60);
      if (savesSinceConsolidate >= 10 || hoursSinceClean >= 24) {
        savesSinceConsolidate = 0;
        lastConsolidateAt = Date.now();
        consolidate(client, embedder, userId, { project_root: projectRoot })
          .then(() => clean(client, embedder, userId, { project_root: projectRoot }))
          .then(() => console.error('Auto-consolidate + clean completed'))
          .catch((err) => console.error('Auto-consolidate failed:', err));
        parts.push('*Background consolidation triggered.*');
      }

      // 4. Recent context — show summaries of most recently accessed memories
      const sorted = [...active].sort((a, b) =>
        new Date(b.last_accessed ?? b.created_at).getTime() -
        new Date(a.last_accessed ?? a.created_at).getTime()
      );
      const recent = sorted.slice(0, 10);
      if (recent.length > 0) {
        parts.push('## Recent Context');
        for (const m of recent) {
          parts.push(`- [${m.type}] ${m.project}: ${m.summary}`);
        }
        parts.push('');
      }

      parts.push('## Ready');
      parts.push('Long-term memory is online. Use memory_search to dive deeper into any topic above. Use memory_save whenever you learn something worth remembering.');

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 12: memory_checkpoint
  // ═══════════════════════════════════════
  server.tool(
    'memory_checkpoint',
    'Call this BEFORE telling the user a task is done. Captures the full problem→solution context as a structured memory for future sessions. Use after: bug fixes, feature implementations, refactors, config changes, architecture decisions. Every completed task = one checkpoint.',
    {
      task_summary: z.string().describe('One-line: what was accomplished'),
      problem: z.string().describe('What was the issue, question, or goal'),
      solution: z.string().describe('How it was solved — approach, key details, why this approach'),
      files: z.array(z.string()).describe('Files created or modified'),
      concepts: z.array(z.string()).describe('Searchable concepts (e.g. ["auth", "jwt", "middleware"])'),
      project: z.string().describe('Project name'),
      tags: z.array(z.string()).optional().describe('Additional tags'),
    },
    async ({ task_summary, problem, solution, files, concepts, project, tags }) => {
      await ensureCollection(client, embedder.provider);

      // Build rich content from structured fields
      const content = [
        task_summary,
        '',
        `Problem: ${problem}`,
        '',
        `Solution: ${solution}`,
        '',
        files.length > 0 ? `Files: ${files.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const result = await writeMemory(client, embedder, {
        content,
        type: 'fact' as MemoryType,
        project,
        tags: ['checkpoint', 'task-completion', ...(tags ?? [])],
        source: 'agent',
        user_id: userId,
        problem,
        solution,
        files,
        concepts,
      });

      // Add to MEMORY.md
      if (!result.deduplicated) {
        const mem = await getMemory(client, result.id);
        if (mem) {
          let state = await readMemoryMd(projectRoot);
          state = addLine(state, {
            type: mem.type,
            summary: mem.summary,
            engram_id: mem.id,
            project: mem.project,
          });
          await writeMemoryMd(state, projectRoot);
        }
      }

      // Auto-consolidate check
      savesSinceConsolidate++;
      const hoursSinceClean = (Date.now() - lastConsolidateAt) / (1000 * 60 * 60);
      if (savesSinceConsolidate >= 10 || hoursSinceClean >= 24) {
        savesSinceConsolidate = 0;
        lastConsolidateAt = Date.now();
        consolidate(client, embedder, userId, { project_root: projectRoot })
          .then(() => clean(client, embedder, userId, { project_root: projectRoot }))
          .catch((err) => console.error('Auto-consolidate failed:', err));
      }

      return {
        content: [{
          type: 'text' as const,
          text: result.deduplicated
            ? `Checkpoint merged with existing memory: ${result.id}`
            : [
                `Checkpoint saved: ${result.id}`,
                `  Problem: ${problem.slice(0, 100)}`,
                `  Solution: ${solution.slice(0, 100)}`,
                `  Files: ${files.join(', ')}`,
                `  Concepts: ${concepts.join(', ')}`,
              ].join('\n'),
        }],
      };
    }
  );

  // ═══════════════════════════════════════
  // Tool 13: memory_compress
  // ═══════════════════════════════════════
  server.tool(
    'memory_compress',
    'Compress local .md memory files that have been persisted to the DB. Replaces redundant files with minimal stubs to keep context window clean. Call after a long session or when context feels bloated.',
    {
      dry_run: z.boolean().optional().describe('Preview without compressing (default false)'),
    },
    async ({ dry_run }) => {
      await ensureCollection(client, embedder.provider);

      const { readdir, readFile: readF, writeFile: writeF } = await import('node:fs/promises');
      const { join, basename } = await import('node:path');
      const { homedir } = await import('node:os');

      const claudeDir = join(homedir(), '.claude', 'projects');
      let totalFound = 0;
      let alreadyCompressed = 0;
      let compressed = 0;
      let notInDb = 0;
      const details: string[] = [];

      try {
        const projects = await readdir(claudeDir).catch(() => [] as string[]);

        for (const proj of projects) {
          const memoryDir = join(claudeDir, proj, 'memory');
          let files: string[];
          try {
            files = await readdir(memoryDir);
          } catch {
            continue; // No memory dir for this project
          }

          const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
          totalFound += mdFiles.length;

          for (const file of mdFiles) {
            const filePath = join(memoryDir, file);
            const content = await readF(filePath, 'utf-8');

            // Check if already compressed
            if (content.includes('persisted: true')) {
              alreadyCompressed++;
              continue;
            }

            // Parse body (skip frontmatter)
            const parts = content.split('---');
            const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : content.trim();
            if (!body || body.length < 10) {
              alreadyCompressed++;
              continue;
            }

            // Check if content exists in Qdrant
            try {
              const { vector } = await embedder.embed(body.slice(0, 2000));
              const matches = await searchMemories(
                client, vector,
                { user_id: userId, status: 'active', embedding_provider: embedder.provider },
                1
              );

              if (matches.length > 0 && matches[0].score > 0.9) {
                // Content is in DB — safe to compress
                if (!dry_run) {
                  // Extract type from frontmatter
                  const typeMatch = content.match(/^type:\s*(.+)$/m);
                  const origType = typeMatch?.[1]?.trim() ?? 'fact';
                  const stub = `---\ntype: ${origType}\npersisted: true\n---\nPersisted to nan-forget DB. Use memory_search to retrieve.\n`;
                  await writeF(filePath, stub, 'utf-8');
                }
                compressed++;
                details.push(`${dry_run ? 'Would compress' : 'Compressed'}: ${proj}/${file}`);
              } else {
                notInDb++;
              }
            } catch {
              notInDb++;
            }
          }
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error scanning memory files: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const lines = [
        `Memory compression ${dry_run ? '(dry run)' : 'complete'}:`,
        `  Files found:        ${totalFound}`,
        `  Already compressed: ${alreadyCompressed}`,
        `  ${dry_run ? 'Would compress' : 'Compressed'}:    ${compressed}`,
        `  Not in DB (kept):   ${notInDb}`,
      ];
      if (details.length > 0) {
        lines.push('', ...details);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  return { server, client, embedder };
}

// --- Main ---

async function main() {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NaN Forget MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
