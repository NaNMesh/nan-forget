#!/usr/bin/env node
/**
 * NaN Forget CLI
 *
 * Usage:
 *   nan-forget add "text" [--type TYPE] [--project PROJECT] [--tags t1,t2]
 *   nan-forget search "query" [--project PROJECT] [--type TYPE] [--depth 1|2|3]
 *   nan-forget get <id>
 *   nan-forget list [--project PROJECT] [--type TYPE] [--status STATUS]
 *   nan-forget update <id> [--content "text"] [--type TYPE] [--tags t1,t2]
 *   nan-forget archive <id>
 *   nan-forget clean
 *   nan-forget consolidate [--project PROJECT]
 *   nan-forget stats
 *   nan-forget export
 *   nan-forget serve   (start MCP server on stdio)
 *   nan-forget api     (start REST API server)
 *   nan-forget start   (start all services)
 */

import { parseArgs } from 'node:util';
import { createQdrantClient, ensureCollection, getMemory, updateMemory, scrollMemories, deleteCollection } from '../qdrant.js';
import { createEmbedder } from '../embeddings.js';
import { writeMemory } from '../writer.js';
import { retrieve } from '../retriever.js';
import { clean } from '../cleaner.js';
import { consolidate } from '../consolidator.js';
import { read as readMemoryMd } from '../memory-md.js';
import type { MemoryType, MemoryStatus, EmbeddingProvider } from '../types.js';

// --- Config ---

function getConfig() {
  return {
    qdrantUrl: process.env.NAN_FORGET_QDRANT_URL ?? 'http://localhost:6333',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    // Auto-detect: use OpenAI if key exists, otherwise Ollama (free, local)
    embeddingProvider: (
      process.env.NAN_FORGET_EMBEDDING_PROVIDER ??
      (process.env.OPENAI_API_KEY ? 'openai' : 'ollama')
    ) as EmbeddingProvider,
    userId: process.env.NAN_FORGET_USER_ID ?? 'default',
    projectRoot: process.env.NAN_FORGET_PROJECT_ROOT ?? process.cwd(),
  };
}

function getClient() {
  const cfg = getConfig();
  return {
    client: createQdrantClient(cfg.qdrantUrl),
    embedder: createEmbedder({ provider: cfg.embeddingProvider, openaiApiKey: cfg.openaiApiKey }),
    ...cfg,
  };
}

// --- Commands ---

export async function cmdAdd(args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      type: { type: 'string', short: 't', default: 'fact' },
      project: { type: 'string', short: 'p', default: '_global' },
      tags: { type: 'string', default: '' },
    },
    allowPositionals: true,
  });

  const content = positionals.join(' ');
  if (!content) return 'Error: No content provided. Usage: nan-forget add "your memory text"';

  const { client, embedder, userId } = getClient();
  await ensureCollection(client, embedder.provider);

  const result = await writeMemory(client, embedder, {
    content,
    type: values.type as MemoryType,
    project: values.project!,
    tags: values.tags ? values.tags.split(',').map((t) => t.trim()) : [],
    user_id: userId,
  });

  if (result.deduplicated) {
    return `✓ Memory already exists (dedup match). Updated: ${result.id}`;
  }
  return `✓ Memory saved: ${result.id}`;
}

export async function cmdSearch(args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      project: { type: 'string', short: 'p' },
      type: { type: 'string', short: 't' },
      depth: { type: 'string', short: 'd', default: '2' },
    },
    allowPositionals: true,
  });

  const query = positionals.join(' ');
  if (!query) return 'Error: No query provided. Usage: nan-forget search "your query"';

  const { client, embedder, userId } = getClient();
  await ensureCollection(client, embedder.provider);

  const maxStage = Math.min(3, Math.max(1, parseInt(values.depth!, 10))) as 1 | 2 | 3;
  const result = await retrieve(client, embedder, query, {
    user_id: userId,
    project: values.project,
  }, { maxStage, limit: 5 });

  const lines: string[] = [];

  if (result.recall.length > 0) {
    for (const r of result.recall) {
      lines.push(`[${r.memory.type}] ${r.memory.summary}`);
      lines.push(`  ${r.memory.content}`);
      lines.push(`  score: ${r.adjusted_score.toFixed(3)} | project: ${r.memory.project} | id: ${r.memory.id}`);
      lines.push('');
    }
  } else if (result.recognition.length > 0) {
    for (const r of result.recognition) {
      lines.push(`[${r.type}] ${r.summary} (score: ${r.adjusted_score.toFixed(3)}, id: ${r.id})`);
    }
  }

  if (result.associations.length > 0) {
    lines.push('--- Associated ---');
    for (const a of result.associations) {
      lines.push(`  [${a.memory.type}] ${a.memory.summary} (id: ${a.memory.id})`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No memories found.';
}

export async function cmdGet(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) return 'Error: No ID provided. Usage: nan-forget get <id>';

  const { client } = getClient();
  const mem = await getMemory(client, id);
  if (!mem) return `Memory not found: ${id}`;

  return JSON.stringify(mem, null, 2);
}

export async function cmdList(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string', short: 'p' },
      type: { type: 'string', short: 't' },
      status: { type: 'string', short: 's', default: 'active' },
      limit: { type: 'string', short: 'n', default: '20' },
    },
    allowPositionals: true,
  });

  const { client, userId } = getClient();

  const memories = await scrollMemories(client, {
    user_id: userId,
    project: values.project,
    type: values.type as MemoryType | undefined,
    status: values.status as MemoryStatus,
  }, parseInt(values.limit!, 10));

  if (memories.length === 0) return 'No memories found.';

  const lines = memories.map((m) =>
    `[${m.type}] ${m.summary}  (project: ${m.project}, id: ${m.id})`
  );

  return `${memories.length} memories:\n\n${lines.join('\n')}`;
}

export async function cmdUpdate(args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      content: { type: 'string', short: 'c' },
      type: { type: 'string', short: 't' },
      tags: { type: 'string' },
    },
    allowPositionals: true,
  });

  const id = positionals[0];
  if (!id) return 'Error: No ID provided. Usage: nan-forget update <id> [--content "text"] [--type TYPE] [--tags t1,t2]';

  const { client } = getClient();
  const existing = await getMemory(client, id);
  if (!existing) return `Memory not found: ${id}`;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (values.content) updates.content = values.content;
  if (values.type) updates.type = values.type;
  if (values.tags) updates.tags = values.tags.split(',').map((t) => t.trim());

  await updateMemory(client, id, updates);
  return `✓ Memory updated: ${id}`;
}

export async function cmdArchive(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) return 'Error: No ID provided. Usage: nan-forget archive <id>';

  const { client } = getClient();
  const existing = await getMemory(client, id);
  if (!existing) return `Memory not found: ${id}`;

  await updateMemory(client, id, { status: 'archived', updated_at: new Date().toISOString() });
  return `✓ Memory archived: ${id}`;
}

export async function cmdClean(_args: string[]): Promise<string> {
  const { client, embedder, userId, projectRoot } = getClient();
  await ensureCollection(client, embedder.provider);

  const result = await clean(client, embedder, userId, { project_root: projectRoot });

  return [
    '✓ Clean complete:',
    `  Archived (decayed):  ${result.archived_decayed}`,
    `  Archived (expired):  ${result.archived_expired}`,
    `  Archived (deduped):  ${result.archived_deduped}`,
    `  MEMORY.md synced:    ${result.memory_md_synced}`,
    `  Duration:            ${result.duration_ms}ms`,
  ].join('\n');
}

export async function cmdStats(_args: string[]): Promise<string> {
  const { client, userId } = getClient();

  const active = await scrollMemories(client, { user_id: userId, status: 'active' }, 1000);
  const archived = await scrollMemories(client, { user_id: userId, status: 'archived' }, 1000);

  // Count by type
  const byType: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const m of active) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    byProject[m.project] = (byProject[m.project] ?? 0) + 1;
  }

  const lines = [
    `NaN Forget — Memory Stats`,
    ``,
    `Active:   ${active.length}`,
    `Archived: ${archived.length}`,
    `Total:    ${active.length + archived.length}`,
    ``,
    `By type:`,
    ...Object.entries(byType).sort().map(([k, v]) => `  ${k}: ${v}`),
    ``,
    `By project:`,
    ...Object.entries(byProject).sort().map(([k, v]) => `  ${k}: ${v}`),
  ];

  return lines.join('\n');
}

export async function cmdConsolidate(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string', short: 'p' },
    },
    strict: false,
  });

  const { client, embedder, userId, projectRoot } = getClient();
  await ensureCollection(client, embedder.provider);

  const result = await consolidate(client, embedder, userId, {
    project: values.project as string | undefined,
    project_root: projectRoot,
  });

  return [
    '✓ Consolidation complete:',
    `  Clusters found:        ${result.clusters_found}`,
    `  Memories consolidated:  ${result.memories_consolidated}`,
    `  New entries created:    ${result.new_memories_created}`,
    `  Duration:              ${result.duration_ms}ms`,
  ].join('\n');
}

export async function cmdExport(_args: string[]): Promise<string> {
  const { client, userId } = getClient();

  const all = await scrollMemories(client, { user_id: userId }, 10000);
  return JSON.stringify(all, null, 2);
}

// --- Router ---

const COMMANDS: Record<string, (args: string[]) => Promise<string>> = {
  add: cmdAdd,
  search: cmdSearch,
  get: cmdGet,
  list: cmdList,
  update: cmdUpdate,
  archive: cmdArchive,
  clean: cmdClean,
  consolidate: cmdConsolidate,
  stats: cmdStats,
  export: cmdExport,
};

const HELP = `
NaN Forget — Long-term memory for AI coding tools

Usage: nan-forget <command> [options]

Commands:
  add "text"         Save a memory
  search "query"     Search memories
  get <id>           Get memory by ID
  list               List memories
  update <id>        Update a memory
  archive <id>       Archive a memory
  clean              Run cleaner (GC + sync)
  consolidate        Consolidate aging memories into long-term entries
  stats              Show memory stats
  export             Export all memories as JSON
  serve              Start MCP server (stdio)
  api                Start REST API server
  start              Start all services (Qdrant + Ollama + API)
  prompt             Print system prompt for non-MCP LLMs

Options (vary by command):
  -t, --type         fact|decision|preference|task|context
  -p, --project      Project name
  --tags             Comma-separated tags
  -d, --depth        Search depth 1-3
  -n, --limit        Max results

Environment:
  OPENAI_API_KEY                 OpenAI API key
  NAN_FORGET_QDRANT_URL          Qdrant URL (default: http://localhost:6333)
  NAN_FORGET_EMBEDDING_PROVIDER  openai|ollama (default: openai)
  NAN_FORGET_USER_ID             User ID (default: default)
  NAN_FORGET_PROJECT_ROOT        Project root for MEMORY.md
`.trim();

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const args = argv.slice(1);

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'serve') {
    // Dynamic import to avoid loading MCP SDK for non-serve commands
    await import('../mcp/server.js');
    return;
  }

  if (command === 'api') {
    const { startApiServer } = await import('../api/server.js');
    const port = parseInt(args[0] ?? process.env.NAN_FORGET_API_PORT ?? '3456', 10);
    startApiServer(port);
    return;
  }

  if (command === 'start') {
    const { startAll, checkHealth } = await import('../services.js');
    console.log('\nNaN Forget — Starting Services\n');
    const result = await startAll();
    console.log(`  Qdrant:   ${result.qdrant.started ? '✓ running' : '✗ ' + (result.qdrant.error ?? 'failed')}`);
    console.log(`  Ollama:   ${result.ollama.started ? '✓ running' : '✗ ' + (result.ollama.error ?? 'failed')}`);
    console.log(`  REST API: ${result.api.started ? '✓ running' : '✗ ' + (result.api.error ?? 'failed')}`);
    const health = await checkHealth();
    const allUp = health.qdrant && health.ollama && health.api;
    console.log(allUp ? '\n  All services running.\n' : '\n  Some services failed. Check errors above.\n');
    return;
  }

  if (command === 'prompt') {
    const { getSystemPrompt } = await import('../api/server.js');
    const host = args[0] ?? `http://localhost:${process.env.NAN_FORGET_API_PORT ?? '3456'}`;
    console.log(getSystemPrompt(host));
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    const output = await handler(args);
    console.log(output);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly
const isMain = process.argv[1]?.includes('cli/index');
if (isMain) {
  run();
}
