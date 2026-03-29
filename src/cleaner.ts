/**
 * Deterministic Cleaner — "Sleep Consolidation"
 *
 * Zero LLM calls. Runs periodically (or on-demand) to:
 *
 * 1. Garbage Collection — archive decayed memories
 *    - Memories below decay threshold that haven't been accessed → archived
 *    - Like brain's forgetting curve — unused memories fade
 *
 * 2. Interference Resolution — dedup near-identical memories
 *    - Find memories with very high vector similarity (>0.95)
 *    - Keep the one with higher access_count, archive the other
 *    - Like brain's interference — new memories overwrite old on same topic
 *
 * 3. Expiration — archive expired memories
 *    - Memories with expires_at in the past → archived
 *
 * 4. MEMORY.md Sync — refresh working memory
 *    - Pull top N memories per project (by adjusted score)
 *    - Replace MEMORY.md project section
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import type { createEmbedder } from './embeddings.js';
import {
  searchMemories,
  updateMemory,
  scrollMemories,
} from './qdrant.js';
import { decayWeight, adjustedScore } from './retriever.js';
import {
  read as readMemoryMd,
  write as writeMemoryMd,
  syncFromTopMemories,
} from './memory-md.js';
import type { Memory, MemorySearchFilters } from './types.js';

// --- Config ---

export interface CleanerConfig {
  /** Decay threshold — memories below this get archived. Default 0.1 (≈100 days untouched). */
  decay_threshold: number;
  /** Similarity threshold for interference/dedup. Default 0.95. */
  dedup_similarity: number;
  /** Max memories to scan per run. Default 500. */
  scan_limit: number;
  /** Top memories per project to keep in MEMORY.md. Default 10. */
  memory_md_per_project: number;
  /** Project root for MEMORY.md. Default cwd. */
  project_root?: string;
}

export const DEFAULT_CONFIG: CleanerConfig = {
  decay_threshold: 0.1,
  dedup_similarity: 0.95,
  scan_limit: 500,
  memory_md_per_project: 5,
};

// --- Result ---

export interface CleanerResult {
  archived_decayed: number;
  archived_expired: number;
  archived_deduped: number;
  memory_md_synced: boolean;
  duration_ms: number;
}

// --- Step 1: Garbage Collection (decay) ---

export async function gcDecayed(
  client: QdrantClient,
  userId: string,
  config: CleanerConfig
): Promise<string[]> {
  const archived: string[] = [];

  const results = await scrollMemories(client, {
    user_id: userId,
    status: 'active',
  }, config.scan_limit);

  for (const mem of results) {
    const decay = decayWeight(mem.last_accessed);
    if (decay < config.decay_threshold) {
      await updateMemory(client, mem.id, { status: 'archived' });
      archived.push(mem.id);
    }
  }

  return archived;
}

// --- Step 2: Expiration ---

export async function gcExpired(
  client: QdrantClient,
  userId: string,
  config: CleanerConfig
): Promise<string[]> {
  const archived: string[] = [];
  const now = new Date().toISOString();

  const results = await scrollMemories(client, {
    user_id: userId,
    status: 'active',
  }, config.scan_limit);

  for (const mem of results) {
    if (mem.expires_at && mem.expires_at < now) {
      await updateMemory(client, mem.id, { status: 'archived' });
      archived.push(mem.id);
    }
  }

  return archived;
}

// --- Step 3: Interference Resolution (dedup) ---

export async function gcDuplicates(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  userId: string,
  config: CleanerConfig
): Promise<string[]> {
  const archived: string[] = [];
  const archivedSet = new Set<string>();

  const results = await scrollMemories(client, {
    user_id: userId,
    status: 'active',
    embedding_provider: embedder.provider,
  }, config.scan_limit);

  // For each memory, find near-duplicates
  for (const mem of results) {
    if (archivedSet.has(mem.id)) continue;

    const { vector } = await embedder.embed(mem.content);
    const similar = await searchMemories(
      client,
      vector,
      {
        user_id: userId,
        status: 'active',
        embedding_provider: embedder.provider,
      },
      5
    );

    for (const match of similar) {
      if (match.memory.id === mem.id) continue;
      if (archivedSet.has(match.memory.id)) continue;
      if (match.score < config.dedup_similarity) continue;

      // Same project + same type = likely duplicate
      if (match.memory.project !== mem.project) continue;
      if (match.memory.type !== mem.type) continue;

      // Keep the one with higher access count (more "consolidated")
      const loser =
        (match.memory.access_count ?? 0) > (mem.access_count ?? 0)
          ? mem
          : match.memory;

      await updateMemory(client, loser.id, { status: 'archived' });
      archivedSet.add(loser.id);
      archived.push(loser.id);
    }
  }

  return archived;
}

// --- Step 4: MEMORY.md Sync ---

export async function syncMemoryMd(
  client: QdrantClient,
  userId: string,
  config: CleanerConfig
): Promise<boolean> {
  // Get all active memories grouped by project
  const results = await scrollMemories(client, {
    user_id: userId,
    status: 'active',
  }, config.scan_limit);

  // Group by project, score, sort
  const byProject = new Map<string, (Memory & { adj_score: number })[]>();
  for (const mem of results) {
    const adj = adjustedScore(1.0, mem.last_accessed, mem.access_count ?? 0);
    const project = mem.project ?? '_global';
    const existing = byProject.get(project) ?? [];
    existing.push({ ...mem, adj_score: adj });
    byProject.set(project, existing);
  }

  let state = await readMemoryMd(config.project_root);

  for (const [project, memories] of byProject) {
    memories.sort((a, b) => b.adj_score - a.adj_score);
    state = syncFromTopMemories(
      state,
      project,
      memories.slice(0, config.memory_md_per_project)
    );
  }

  await writeMemoryMd(state, config.project_root);
  return true;
}

// --- Full Clean ---

export async function clean(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  userId: string,
  config: Partial<CleanerConfig> = {}
): Promise<CleanerResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const start = Date.now();

  const decayed = await gcDecayed(client, userId, cfg);
  const expired = await gcExpired(client, userId, cfg);
  const deduped = await gcDuplicates(client, embedder, userId, cfg);
  const synced = await syncMemoryMd(client, userId, cfg);

  return {
    archived_decayed: decayed.length,
    archived_expired: expired.length,
    archived_deduped: deduped.length,
    memory_md_synced: synced,
    duration_ms: Date.now() - start,
  };
}
