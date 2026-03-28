#!/usr/bin/env node
/**
 * NaN Forget MCP Server
 *
 * 8 tools: memory_save, memory_search, memory_get, memory_update, memory_archive,
 *          memory_consolidate, memory_clean, memory_stats
 * Runs over stdio. Connects to local Qdrant.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createQdrantClient, ensureCollection, getMemory, updateMemory, scrollMemories } from '../qdrant.js';
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
    version: '0.1.1',
  });

  // ═══════════════════════════════════════
  // Tool 1: memory_save
  // ═══════════════════════════════════════
  server.tool(
    'memory_save',
    'Save a memory to long-term storage. Use this when you learn something worth remembering: decisions, preferences, facts, context, or tasks. Deduplicates automatically — safe to call even if you think it might already exist.',
    {
      content: z.string().describe('The full text of the memory to save'),
      type: z.enum(['fact', 'decision', 'preference', 'task', 'context']).describe('Memory type'),
      project: z.string().describe('Project name this memory belongs to'),
      tags: z.array(z.string()).optional().describe('Optional tags for filtering'),
    },
    async ({ content, type, project, tags }) => {
      await ensureCollection(client, embedder.provider);

      const result = await writeMemory(client, embedder, {
        content,
        type: type as MemoryType,
        project,
        tags,
        user_id: userId,
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
    'Search your long-term memory. Use this when you need project context, past decisions, preferences, or facts from previous sessions. Returns memories ranked by relevance and recency. Depth 1 = fast blur (summaries only), depth 2 = full content, depth 3 = full + associated memories.',
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
