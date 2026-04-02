/**
 * NaN Forget REST API Server
 *
 * Lightweight HTTP API for non-MCP clients (Codex, custom integrations).
 * Shares the same SQLite database as the MCP server — same memories, same indexes.
 *
 * Usage: nan-forget api [--port 3456]
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createDb, ensureSchema, getMemory, updateMemory, scrollMemories } from '../sqlite.js';
import { createEmbedder } from '../embeddings.js';
import { buildCheckpointContent, writeMemory } from '../writer.js';
import { retrieve } from '../retriever.js';
import { clean } from '../cleaner.js';
import { consolidate } from '../consolidator.js';
import type { MemoryType } from '../types.js';
import type Database from 'better-sqlite3';

// --- Config ---

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const EMBEDDING_PROVIDER = (
  process.env.NAN_FORGET_EMBEDDING_PROVIDER ??
  (OPENAI_API_KEY ? 'openai' : 'ollama')
) as 'openai' | 'ollama';
const USER_ID = process.env.NAN_FORGET_USER_ID ?? 'default';
const PROJECT_ROOT = process.env.NAN_FORGET_PROJECT_ROOT ?? process.cwd();
const PORT = parseInt(process.env.NAN_FORGET_API_PORT ?? '3456', 10);

interface ApiServerOptions {
  client?: Database.Database;
  embedder?: ReturnType<typeof createEmbedder>;
  userId?: string;
  projectRoot?: string;
}

// --- Helpers ---

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

// --- Router ---

export function startApiServer(port = PORT, options: ApiServerOptions = {}) {
  const client = options.client ?? createDb();
  const embedder = options.embedder ?? createEmbedder({
    provider: EMBEDDING_PROVIDER,
    openaiApiKey: OPENAI_API_KEY,
  });
  const userId = options.userId ?? USER_ID;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      ensureSchema(client, embedder.provider);

      // POST /memories — save
      if (method === 'POST' && path === '/memories') {
        const body = await readBody(req);
        const content = body.content as string;
        const type = body.type as MemoryType;
        const project = body.project as string;
        const tags = stringArray(body.tags);
        const problem = body.problem as string | undefined;
        const solution = body.solution as string | undefined;
        const files = stringArray(body.files);
        const concepts = stringArray(body.concepts);

        if (!content || !type || !project) {
          return error(res, 'Required: content, type, project');
        }

        const result = await writeMemory(client, embedder, {
          content,
          type,
          project,
          tags,
          user_id: userId,
          problem,
          solution,
          files,
          concepts,
        });
        return json(res, result, 201);
      }

      // POST /memories/checkpoint — save completed-task context
      if (method === 'POST' && path === '/memories/checkpoint') {
        const body = await readBody(req);
        const taskSummary = body.task_summary as string;
        const problem = body.problem as string;
        const solution = body.solution as string;
        const project = body.project as string;
        const files = stringArray(body.files) ?? [];
        const concepts = stringArray(body.concepts) ?? [];
        const tags = stringArray(body.tags) ?? [];

        if (!taskSummary || !problem || !solution || !project || concepts.length === 0) {
          return error(res, 'Required: task_summary, problem, solution, project, concepts');
        }

        const result = await writeMemory(client, embedder, {
          content: buildCheckpointContent(taskSummary, problem, solution, files),
          type: 'fact',
          project,
          tags: ['checkpoint', 'task-completion', ...tags],
          user_id: userId,
          problem,
          solution,
          files,
          concepts,
        });
        return json(res, result, 201);
      }

      // GET /memories/search?q=...&project=...&depth=...
      if (method === 'GET' && path === '/memories/search') {
        const query = url.searchParams.get('q');
        if (!query) return error(res, 'Required: q parameter');

        const project = url.searchParams.get('project') ?? undefined;
        const depth = parseInt(url.searchParams.get('depth') ?? '2', 10) as 1 | 2 | 3;

        const result = await retrieve(client, embedder, query, {
          user_id: userId, project,
        }, { maxStage: depth, limit: 5 });
        return json(res, result);
      }

      // GET /memories/stats
      if (method === 'GET' && path === '/memories/stats') {
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

        return json(res, {
          active: active.length,
          archived: archived.length,
          consolidated: consolidatedCount,
          total: active.length + archived.length,
          by_type: byType,
          by_project: byProject,
        });
      }

      // POST /memories/consolidate
      if (method === 'POST' && path === '/memories/consolidate') {
        const body = await readBody(req);
        const result = await consolidate(client, embedder, userId, {
          project: body.project as string | undefined,
          project_root: projectRoot,
        });
        return json(res, result);
      }

      // POST /memories/sync — lightweight handshake (health + stats, no search)
      if (method === 'POST' && path === '/memories/sync') {
        const active = await scrollMemories(client, { user_id: userId, status: 'active' }, 1000);
        const byProject: Record<string, number> = {};
        for (const m of active) {
          byProject[m.project] = (byProject[m.project] ?? 0) + 1;
        }

        return json(res, {
          status: 'ready',
          active_memories: active.length,
          projects: byProject,
          message: 'Long-term memory online. Use GET /memories/search?q=<topic> during conversation for dynamic recall.',
        });
      }

      // GET /memories/instructions — system prompt for non-MCP LLMs
      if (method === 'GET' && path === '/memories/instructions') {
        const port = url.port || '3456';
        const host = `http://localhost:${port}`;
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(getSystemPrompt(host));
        return;
      }

      // POST /memories/clean
      if (method === 'POST' && path === '/memories/clean') {
        const result = await clean(client, embedder, userId, {
          project_root: projectRoot,
        });
        return json(res, result);
      }

      // GET /memories/:id
      const getMatch = path.match(/^\/memories\/([a-f0-9-]+)$/);
      if (method === 'GET' && getMatch) {
        const mem = await getMemory(client, getMatch[1]);
        if (!mem) return error(res, 'Not found', 404);
        return json(res, mem);
      }

      // PATCH /memories/:id
      const patchMatch = path.match(/^\/memories\/([a-f0-9-]+)$/);
      if (method === 'PATCH' && patchMatch) {
        const existing = await getMemory(client, patchMatch[1]);
        if (!existing) return error(res, 'Not found', 404);

        const body = await readBody(req);
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.content !== undefined) updates.content = body.content;
        if (body.type !== undefined) updates.type = body.type;
        if (body.tags !== undefined) updates.tags = body.tags;
        if (body.project !== undefined) updates.project = body.project;
        if (body.problem !== undefined) updates.problem = body.problem;
        if (body.solution !== undefined) updates.solution = body.solution;
        if (body.files !== undefined) updates.files = stringArray(body.files) ?? [];
        if (body.concepts !== undefined) updates.concepts = stringArray(body.concepts) ?? [];

        await updateMemory(client, patchMatch[1], updates);
        return json(res, { updated: patchMatch[1] });
      }

      // DELETE /memories/:id — archive (soft delete)
      const deleteMatch = path.match(/^\/memories\/([a-f0-9-]+)$/);
      if (method === 'DELETE' && deleteMatch) {
        const existing = await getMemory(client, deleteMatch[1]);
        if (!existing) return error(res, 'Not found', 404);

        await updateMemory(client, deleteMatch[1], {
          status: 'archived',
          updated_at: new Date().toISOString(),
        });
        return json(res, { archived: deleteMatch[1] });
      }

      // 404
      error(res, 'Not found', 404);
    } catch (err) {
      console.error('API error:', err);
      error(res, 'Internal server error', 500);
    }
  });

  server.listen(port, () => {
    console.error(`NaN Forget REST API running on http://localhost:${port}`);
    console.error('Endpoints:');
    console.error('  POST   /memories              — save a memory');
    console.error('  POST   /memories/checkpoint   — save a completed-task memory');
    console.error('  GET    /memories/search?q=...  — search memories');
    console.error('  GET    /memories/:id           — get by ID');
    console.error('  PATCH  /memories/:id           — update');
    console.error('  DELETE /memories/:id           — archive');
    console.error('  POST   /memories/consolidate   — consolidate aging memories');
    console.error('  POST   /memories/sync           — all-in-one context loader');
    console.error('  POST   /memories/clean         — garbage collection');
    console.error('  GET    /memories/stats          — memory stats');
    console.error('  GET    /memories/instructions   — system prompt for LLMs');
  });

  return server;
}

// --- System Prompt for Non-MCP LLMs ---

export function getSystemPrompt(host = 'http://localhost:3456'): string {
  return `You have access to a long-term memory system at ${host}. You MUST follow these rules:

1. AT SESSION START: Call POST ${host}/memories/sync to verify the memory system is online. This returns how many memories exist and which projects are tracked. It does NOT search — searching happens dynamically.

2. DURING THE SESSION — SEARCH: Whenever you encounter a topic that may have prior context (auth, deployment, testing, architecture, tooling, etc.), call GET ${host}/memories/search?q=<topic> IMMEDIATELY. Do NOT wait for the user to ask. Think of this as your long-term recall — use it whenever a topic might have been discussed before, in ANY project.

3. DURING THE SESSION — SAVE: Call POST ${host}/memories immediately whenever you learn a decision, preference, fact, or context worth remembering. Do NOT wait. Save as you go. Use this JSON shape:
   {"content":"<what you learned>","type":"<fact|decision|preference|task|context>","project":"<project name>","tags":["optional"],"problem":"optional","solution":"optional","files":["optional"],"concepts":["optional"]}

4. BEFORE TELLING THE USER A TASK IS DONE: Call POST ${host}/memories/checkpoint with {"task_summary":"<what you finished>","problem":"<what was hard>","solution":"<how you solved it>","files":["file paths"],"concepts":["searchable concepts"],"project":"<project name>","tags":["optional"]}. Every completed task should create one checkpoint.

API Reference:
  POST   ${host}/memories              — Save a memory {content, type, project, tags?, problem?, solution?, files?, concepts?}
  POST   ${host}/memories/checkpoint   — Save completed-task context {task_summary, problem, solution, files, concepts, project, tags?}
  POST   ${host}/memories/sync         — Lightweight handshake
  GET    ${host}/memories/search?q=... — Search memories
  GET    ${host}/memories/:id          — Get by ID
  PATCH  ${host}/memories/:id          — Update {content?, type?, tags?, project?, problem?, solution?, files?, concepts?}
  DELETE ${host}/memories/:id          — Archive (soft delete)
  POST   ${host}/memories/consolidate  — Compact aging memories (usually automatic)
  POST   ${host}/memories/clean        — Garbage collection (usually automatic)
  GET    ${host}/memories/stats        — Memory health metrics

CLI fallback if REST is unavailable but shell access exists:
  nan-forget sync
  nan-forget search "<topic>"
  nan-forget add --type decision --project "<project>" --problem "..." --solution "..." --concepts auth,jwt --files src/auth.ts "..."
  nan-forget checkpoint --summary "..." --problem "..." --solution "..." --files src/auth.ts --concepts auth,jwt --project "<project>"

Memory types: fact, decision, preference, task, context
Context management is automatic — consolidation and cleanup happen after every 10 saves.`;
}

// --- Main ---
if (process.argv[1]?.endsWith('api/server.ts') || process.argv[1]?.endsWith('api/server.js')) {
  startApiServer();
}
