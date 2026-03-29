import {
  searchMemories,
  recommendMemories,
  updateMemory,
  getMemory,
} from './sqlite.js';
import type { createEmbedder } from './embeddings.js';
import type Database from 'better-sqlite3';
import type { Memory, MemorySearchFilters } from './types.js';

// --- Types ---

export interface RetrievalContext {
  user_id: string;
  project?: string;
}

/** Stage 1 result — blur. Summary only, no full content. */
export interface RecognitionResult {
  id: string;
  summary: string;
  type: Memory['type'];
  tags: string[];
  concepts: string[];
  project: string;
  score: number;
  adjusted_score: number;
}

/** Stage 2 result — full clarity. */
export interface RecallResult {
  memory: Memory;
  score: number;
  adjusted_score: number;
}

/** Stage 3 result — associated memories via spreading activation. */
export interface AssociationResult {
  memory: Memory;
  score: number;
}

export interface RetrievalResult {
  stage: 1 | 2 | 3;
  recognition: RecognitionResult[];
  recall: RecallResult[];
  associations: AssociationResult[];
}

// --- Scoring ---

const HALF_LIFE_DAYS = 30;

export function decayWeight(lastAccessed: string): number {
  const days = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

export function frequencyBoost(accessCount: number): number {
  return Math.log2(accessCount + 1) / 10 + 1;
}

export function adjustedScore(
  vectorScore: number,
  lastAccessed: string,
  accessCount: number
): number {
  return vectorScore * decayWeight(lastAccessed) * frequencyBoost(accessCount);
}

// --- Stage 1: Recognition (blur) ---

export async function recognize(
  client: Database.Database,
  embedder: ReturnType<typeof createEmbedder>,
  query: string,
  ctx: RetrievalContext,
  limit = 5
): Promise<RecognitionResult[]> {
  const { vector } = await embedder.embed(query);

  const filters: MemorySearchFilters = {
    user_id: ctx.user_id,
    embedding_provider: embedder.provider,
    status: 'active',
  };
  if (ctx.project) filters.project = ctx.project;

  const results = await searchMemories(
    client,
    vector,
    filters,
    limit * 3, // prefetch more, then rank by adjusted score
    ['summary', 'type', 'tags', 'concepts', 'project', 'access_count', 'last_accessed']
  );

  const scored = results.map((r) => ({
    id: r.memory.id,
    summary: r.memory.summary,
    type: r.memory.type,
    tags: r.memory.tags ?? [],
    concepts: r.memory.concepts ?? [],
    project: r.memory.project ?? '_global',
    score: r.score,
    adjusted_score: adjustedScore(
      r.score,
      r.memory.last_accessed,
      r.memory.access_count ?? 0
    ),
  }));

  // Sort by adjusted score, take top N
  scored.sort((a, b) => b.adjusted_score - a.adjusted_score);
  return scored.slice(0, limit);
}

// --- Stage 2: Recall (clarity) ---

export async function recall(
  client: Database.Database,
  embedder: ReturnType<typeof createEmbedder>,
  query: string,
  ctx: RetrievalContext,
  recognitionIds: string[],
  limit = 5
): Promise<RecallResult[]> {
  // Fetch full content for recognition hits
  const fullMemories: RecallResult[] = [];
  for (const id of recognitionIds) {
    const mem = await getMemory(client, id);
    if (mem) {
      const score = adjustedScore(1.0, mem.last_accessed, mem.access_count);
      fullMemories.push({ memory: mem, score: 1.0, adjusted_score: score });
    }
  }

  // Also expand search — cross-project, broader
  const { vector } = await embedder.embed(query);
  const expandedFilters: MemorySearchFilters = {
    user_id: ctx.user_id,
    embedding_provider: embedder.provider,
    status: 'active',
    // No project filter — cross-project search
  };

  const expanded = await searchMemories(client, vector, expandedFilters, limit * 2);

  const existingIds = new Set(recognitionIds);
  for (const r of expanded) {
    if (existingIds.has(r.memory.id)) continue;
    existingIds.add(r.memory.id);

    const adj = adjustedScore(r.score, r.memory.last_accessed, r.memory.access_count);
    fullMemories.push({ memory: r.memory, score: r.score, adjusted_score: adj });
  }

  fullMemories.sort((a, b) => b.adjusted_score - a.adjusted_score);
  return fullMemories.slice(0, limit);
}

// --- Stage 3: Reconstruction (association / spreading activation) ---

export async function reconstruct(
  client: Database.Database,
  positiveIds: string[],
  ctx: RetrievalContext,
  limit = 5
): Promise<AssociationResult[]> {
  if (positiveIds.length === 0) return [];

  const results = await recommendMemories(
    client,
    positiveIds,
    positiveIds, // exclude already-found
    limit,
    { user_id: ctx.user_id, status: 'active' }
  );

  return results.map((r) => ({
    memory: r.memory,
    score: r.score,
  }));
}

// --- Full Pipeline ---

export async function retrieve(
  client: Database.Database,
  embedder: ReturnType<typeof createEmbedder>,
  query: string,
  ctx: RetrievalContext,
  options?: { maxStage?: 1 | 2 | 3; limit?: number }
): Promise<RetrievalResult> {
  const maxStage = options?.maxStage ?? 3;
  const limit = options?.limit ?? 5;

  // Stage 1 — Recognition (blur)
  const recognition = await recognize(client, embedder, query, ctx, limit);

  const result: RetrievalResult = {
    stage: 1,
    recognition,
    recall: [],
    associations: [],
  };

  if (maxStage === 1 || recognition.length === 0) {
    await touchMemories(client, recognition.map((r) => r.id));
    return result;
  }

  // Stage 2 — Recall (clarity)
  const recallResults = await recall(
    client,
    embedder,
    query,
    ctx,
    recognition.map((r) => r.id),
    limit
  );
  result.recall = recallResults;
  result.stage = 2;

  if (maxStage === 2 || recallResults.length === 0) {
    await touchMemories(client, recallResults.map((r) => r.memory.id));
    return result;
  }

  // Stage 3 — Reconstruction (association)
  const allIds = recallResults.map((r) => r.memory.id);
  const associations = await reconstruct(client, allIds, ctx, limit);
  result.associations = associations;
  result.stage = 3;

  await touchMemories(client, [
    ...recallResults.map((r) => r.memory.id),
    ...associations.map((a) => a.memory.id),
  ]);

  return result;
}

// --- Touch (update access stats) ---

async function touchMemories(client: Database.Database, ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const id of ids) {
    const mem = await getMemory(client, id);
    if (!mem) continue;
    await updateMemory(client, id, {
      last_accessed: now,
      access_count: (mem.access_count ?? 0) + 1,
    });
  }
}
