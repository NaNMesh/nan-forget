/**
 * NaN Forget REST API Server
 *
 * Lightweight HTTP API for non-MCP clients (Codex, custom integrations).
 * Shares the same Qdrant backend as the MCP server — same memories, same indexes.
 *
 * Usage: nan-forget api [--port 3456]
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createQdrantClient, ensureCollection, getMemory, updateMemory, scrollMemories } from '../qdrant.js';
import { createEmbedder } from '../embeddings.js';
import { writeMemory } from '../writer.js';
import { retrieve } from '../retriever.js';
import { clean } from '../cleaner.js';
import { consolidate } from '../consolidator.js';
import type { MemoryType } from '../types.js';

// --- Config ---

const QDRANT_URL = process.env.NAN_FORGET_QDRANT_URL ?? 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const EMBEDDING_PROVIDER = (
  process.env.NAN_FORGET_EMBEDDING_PROVIDER ??
  (OPENAI_API_KEY ? 'openai' : 'ollama')
) as 'openai' | 'ollama';
const USER_ID = process.env.NAN_FORGET_USER_ID ?? 'default';
const PROJECT_ROOT = process.env.NAN_FORGET_PROJECT_ROOT ?? process.cwd();
const PORT = parseInt(process.env.NAN_FORGET_API_PORT ?? '3456', 10);

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

// --- Router ---

export function startApiServer(port = PORT) {
  const client = createQdrantClient(QDRANT_URL);
  const embedder = createEmbedder({
    provider: EMBEDDING_PROVIDER,
    openaiApiKey: OPENAI_API_KEY,
  });

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
      await ensureCollection(client, embedder.provider);

      // POST /memories — save
      if (method === 'POST' && path === '/memories') {
        const body = await readBody(req);
        const content = body.content as string;
        const type = body.type as MemoryType;
        const project = body.project as string;
        const tags = body.tags as string[] | undefined;

        if (!content || !type || !project) {
          return error(res, 'Required: content, type, project');
        }

        const result = await writeMemory(client, embedder, {
          content, type, project, tags, user_id: USER_ID,
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
          user_id: USER_ID, project,
        }, { maxStage: depth, limit: 5 });
        return json(res, result);
      }

      // GET /memories/stats
      if (method === 'GET' && path === '/memories/stats') {
        const active = await scrollMemories(client, { user_id: USER_ID, status: 'active' }, 1000);
        const archived = await scrollMemories(client, { user_id: USER_ID, status: 'archived' }, 1000);

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
        const result = await consolidate(client, embedder, USER_ID, {
          project: body.project as string | undefined,
          project_root: PROJECT_ROOT,
        });
        return json(res, result);
      }

      // POST /memories/clean
      if (method === 'POST' && path === '/memories/clean') {
        const result = await clean(client, embedder, USER_ID, {
          project_root: PROJECT_ROOT,
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
    console.error('  GET    /memories/search?q=...  — search memories');
    console.error('  GET    /memories/:id           — get by ID');
    console.error('  PATCH  /memories/:id           — update');
    console.error('  DELETE /memories/:id           — archive');
    console.error('  POST   /memories/consolidate   — consolidate aging memories');
    console.error('  POST   /memories/clean         — garbage collection');
    console.error('  GET    /memories/stats          — memory stats');
  });

  return server;
}

// --- Main ---
if (process.argv[1]?.endsWith('api/server.ts') || process.argv[1]?.endsWith('api/server.js')) {
  startApiServer();
}
