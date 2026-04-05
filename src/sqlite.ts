/**
 * SQLite + sqlite-vec storage layer
 *
 * Replaces Qdrant — zero Docker, single file at ~/.nan-forget/memories.db
 * Uses better-sqlite3 for SQL + sqlite-vec for cosine vector search.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  Memory,
  MemoryPayload,
  MemorySearchFilters,
  EmbeddingProvider,
  MemoryTier,
} from './types.js';
import { VECTOR_DIMENSIONS } from './types.js';

// --- DB Path ---

export const DEFAULT_DB_PATH = join(homedir(), '.nan-forget', 'memories.db');

// --- Create DB ---

export function createDb(dbPath = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  return db;
}

// --- Schema ---

export function ensureSchema(db: Database.Database, provider: EmbeddingProvider): void {
  const dim = VECTOR_DIMENSIONS[provider];

  // Memories table (payload)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      project TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      access_count INTEGER DEFAULT 0,
      last_accessed TEXT NOT NULL,
      embedding_provider TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      consolidated_from TEXT,
      problem TEXT,
      solution TEXT,
      files TEXT,
      concepts TEXT,
      confidence REAL DEFAULT 0.5,
      provenance TEXT DEFAULT 'save',
      tier TEXT DEFAULT 'regular'
    )
  `);

  // Migration: add new columns to existing DBs (safe — IF NOT EXISTS not supported for columns)
  const colCheck = db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'confidence'`
  ).get() as { cnt: number };
  if (colCheck.cnt === 0) {
    db.exec(`ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.5`);
    db.exec(`ALTER TABLE memories ADD COLUMN provenance TEXT DEFAULT 'save'`);
    db.exec(`ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT 'regular'`);
  }

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_provider ON memories(embedding_provider);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_memories_access_count ON memories(access_count);
    CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
  `);

  // Vector table — sqlite-vec virtual table
  // Use IF NOT EXISTS-safe approach: check first
  const vecExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'`
  ).get();

  if (!vecExists) {
    db.exec(`
      CREATE VIRTUAL TABLE vec_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${dim}] distance_metric=cosine
      )
    `);
  }
}

// Alias for backward compat with code that called ensureCollection
export const ensureCollection = ensureSchema;

// --- CRUD ---

export function upsertMemory(
  db: Database.Database,
  memory: Memory,
  vector: number[]
): void {
  const upsertMem = db.prepare(`
    INSERT OR REPLACE INTO memories (
      id, user_id, content, summary, type, status, project, tags, source,
      created_at, updated_at, expires_at, access_count, last_accessed,
      embedding_provider, embedding_model, consolidated_from,
      problem, solution, files, concepts,
      confidence, provenance, tier
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  const upsertVec = db.prepare(`
    INSERT OR REPLACE INTO vec_memories (memory_id, embedding) VALUES (?, ?)
  `);

  const transaction = db.transaction(() => {
    upsertMem.run(
      memory.id,
      memory.user_id,
      memory.content,
      memory.summary,
      memory.type,
      memory.status,
      memory.project,
      JSON.stringify(memory.tags ?? []),
      memory.source,
      memory.created_at,
      memory.updated_at,
      memory.expires_at,
      memory.access_count ?? 0,
      memory.last_accessed,
      memory.embedding_provider,
      memory.embedding_model,
      memory.consolidated_from ? JSON.stringify(memory.consolidated_from) : null,
      memory.problem ?? null,
      memory.solution ?? null,
      memory.files ? JSON.stringify(memory.files) : null,
      memory.concepts ? JSON.stringify(memory.concepts) : null,
      memory.confidence ?? 0.5,
      memory.provenance ?? 'save',
      memory.tier ?? 'regular',
    );

    upsertVec.run(memory.id, new Float32Array(vector));
  });

  transaction();
}

export function getMemory(
  db: Database.Database,
  id: string
): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToMemory(row);
}

export function updateMemory(
  db: Database.Database,
  id: string,
  updates: Partial<MemoryPayload>
): void {
  updates.updated_at = new Date().toISOString();

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    // JSON-encode array/object fields
    if (Array.isArray(value)) {
      values.push(JSON.stringify(value));
    } else {
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function archiveMemory(
  db: Database.Database,
  id: string
): void {
  updateMemory(db, id, {
    status: 'archived',
    updated_at: new Date().toISOString(),
  });
}

// --- Search (vector + filters) ---

export function searchMemories(
  db: Database.Database,
  vector: number[],
  filters: MemorySearchFilters,
  limit = 5,
  _withPayloadFields?: string[] // kept for API compat, ignored (we always return full row)
): Array<{ memory: Memory; score: number }> {
  // Build WHERE clause from filters
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Vector match + k
  params.push(new Float32Array(vector));
  params.push(limit);

  if (filters.user_id) {
    conditions.push('m.user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.status) {
    conditions.push('m.status = ?');
    params.push(filters.status);
  }
  if (filters.project) {
    conditions.push('m.project = ?');
    params.push(filters.project);
  }
  if (filters.type) {
    conditions.push('m.type = ?');
    params.push(filters.type);
  }
  if (filters.embedding_provider) {
    conditions.push('m.embedding_provider = ?');
    params.push(filters.embedding_provider);
  }
  if (filters.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      conditions.push("m.tags LIKE ?");
      params.push(`%"${tag}"%`);
    }
  }
  if (filters.created_after) {
    conditions.push('m.created_at >= ?');
    params.push(filters.created_after);
  }
  if (filters.created_before) {
    conditions.push('m.created_at <= ?');
    params.push(filters.created_before);
  }
  if (filters.last_accessed_after) {
    conditions.push('m.last_accessed >= ?');
    params.push(filters.last_accessed_after);
  }
  if (filters.last_accessed_before) {
    conditions.push('m.last_accessed <= ?');
    params.push(filters.last_accessed_before);
  }
  if (filters.min_access_count !== undefined) {
    conditions.push('m.access_count >= ?');
    params.push(filters.min_access_count);
  }
  if (filters.max_access_count !== undefined) {
    conditions.push('m.access_count <= ?');
    params.push(filters.max_access_count);
  }
  if (filters.tier) {
    conditions.push('m.tier = ?');
    params.push(filters.tier);
  }
  if (filters.min_confidence !== undefined) {
    conditions.push('m.confidence >= ?');
    params.push(filters.min_confidence);
  }

  const whereClause = conditions.length > 0
    ? 'AND ' + conditions.join(' AND ')
    : '';

  const sql = `
    SELECT m.*, v.distance
    FROM vec_memories v
    JOIN memories m ON m.id = v.memory_id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${whereClause}
    ORDER BY v.distance ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown> & { distance: number }>;

  return rows.map((row) => ({
    memory: rowToMemory(row),
    // sqlite-vec cosine distance: 0 = identical, 2 = opposite
    // Convert to similarity score (1 = identical, 0 = orthogonal, -1 = opposite)
    score: 1 - (row.distance as number),
  }));
}

// --- Recommend (spreading activation via centroid) ---

export function recommendMemories(
  db: Database.Database,
  positiveIds: string[],
  excludeIds: string[],
  limit = 5,
  filters?: MemorySearchFilters
): Array<{ memory: Memory; score: number }> {
  if (positiveIds.length === 0) return [];

  // 1. Get vectors for positive IDs
  const placeholders = positiveIds.map(() => '?').join(',');
  const vecRows = db.prepare(
    `SELECT embedding FROM vec_memories WHERE memory_id IN (${placeholders})`
  ).all(...positiveIds) as Array<{ embedding: Buffer }>;

  if (vecRows.length === 0) return [];

  // 2. Compute centroid
  const firstVec = new Float32Array(vecRows[0].embedding.buffer, vecRows[0].embedding.byteOffset, vecRows[0].embedding.byteLength / 4);
  const dim = firstVec.length;
  const centroid = new Float32Array(dim);

  for (const row of vecRows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    for (let i = 0; i < dim; i++) {
      centroid[i] += vec[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= vecRows.length;
  }

  // 3. Search with centroid, applying filters
  const searchFilters: MemorySearchFilters = { ...filters };
  // Request extra to account for exclusions
  const results = searchMemories(db, Array.from(centroid), searchFilters, limit + excludeIds.length);

  // 4. Exclude already-found IDs
  const excludeSet = new Set(excludeIds);
  return results
    .filter((r) => !excludeSet.has(r.memory.id))
    .slice(0, limit);
}

// --- Scroll (batch read with filters, no vector) ---

export function scrollMemories(
  db: Database.Database,
  filters: MemorySearchFilters,
  limit = 100
): Memory[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.user_id) {
    conditions.push('user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters.embedding_provider) {
    conditions.push('embedding_provider = ?');
    params.push(filters.embedding_provider);
  }
  if (filters.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      conditions.push("tags LIKE ?");
      params.push(`%"${tag}"%`);
    }
  }
  if (filters.created_after) {
    conditions.push('created_at >= ?');
    params.push(filters.created_after);
  }
  if (filters.created_before) {
    conditions.push('created_at <= ?');
    params.push(filters.created_before);
  }
  if (filters.last_accessed_after) {
    conditions.push('last_accessed >= ?');
    params.push(filters.last_accessed_after);
  }
  if (filters.last_accessed_before) {
    conditions.push('last_accessed <= ?');
    params.push(filters.last_accessed_before);
  }
  if (filters.min_access_count !== undefined) {
    conditions.push('access_count >= ?');
    params.push(filters.min_access_count);
  }
  if (filters.max_access_count !== undefined) {
    conditions.push('access_count <= ?');
    params.push(filters.max_access_count);
  }
  if (filters.tier) {
    conditions.push('tier = ?');
    params.push(filters.tier);
  }
  if (filters.min_confidence !== undefined) {
    conditions.push('confidence >= ?');
    params.push(filters.min_confidence);
  }

  const whereClause = conditions.length > 0
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  params.push(limit);

  const rows = db.prepare(
    `SELECT * FROM memories ${whereClause} ORDER BY last_accessed DESC LIMIT ?`
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToMemory);
}

// --- Delete ---

export function deletePoints(
  db: Database.Database,
  ids: string[]
): void {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');
  const transaction = db.transaction(() => {
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM vec_memories WHERE memory_id IN (${placeholders})`).run(...ids);
  });
  transaction();
}

export function deleteCollection(db: Database.Database): void {
  try { db.exec('DELETE FROM memories'); } catch { /* table may not exist */ }
  try { db.exec('DELETE FROM vec_memories'); } catch { /* table may not exist */ }
}

// --- Helpers ---

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    content: row.content as string,
    summary: row.summary as string,
    type: row.type as Memory['type'],
    status: row.status as Memory['status'],
    project: row.project as string,
    tags: jsonParse(row.tags as string, []),
    source: row.source as Memory['source'],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    expires_at: (row.expires_at as string) ?? null,
    access_count: (row.access_count as number) ?? 0,
    last_accessed: row.last_accessed as string,
    embedding_provider: row.embedding_provider as Memory['embedding_provider'],
    embedding_model: row.embedding_model as string,
    ...(row.consolidated_from ? { consolidated_from: jsonParse(row.consolidated_from as string, []) } : {}),
    ...(row.problem ? { problem: row.problem as string } : {}),
    ...(row.solution ? { solution: row.solution as string } : {}),
    ...(row.files ? { files: jsonParse(row.files as string, []) } : {}),
    ...(row.concepts ? { concepts: jsonParse(row.concepts as string, []) } : {}),
    confidence: (row.confidence as number) ?? 0.5,
    provenance: (row.provenance as Memory['provenance']) ?? 'save',
    tier: (row.tier as Memory['tier']) ?? 'regular',
  };
}

function jsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}
