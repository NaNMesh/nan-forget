/**
 * Memory Consolidation Engine — "Sleep Consolidation"
 *
 * Turns aging short-term memories into compact long-term entries:
 *
 * 1. Find active memories with decay weight < threshold (aging but not dead)
 * 2. Cluster by project + type, then sub-cluster by vector similarity
 * 3. Summarize each cluster:
 *    - LLM path: OpenAI summarization (if key available)
 *    - Fallback: Deterministic merge (concatenate summaries)
 * 4. Save consolidated memory with fresh vector embedding
 * 5. Archive originals with backlink to consolidated entry
 */

import type { QdrantClient } from '@qdrant/js-client-rest';
import type { createEmbedder } from './embeddings.js';
import {
  scrollMemories,
  searchMemories,
  updateMemory,
  upsertMemory,
} from './qdrant.js';
import { decayWeight } from './retriever.js';
import type { Memory, MemoryType } from './types.js';

// --- Config ---

export interface ConsolidatorConfig {
  /** Decay threshold — consolidate memories below this. Default 0.3 (≈50 days untouched). */
  decay_threshold: number;
  /** Vector similarity to group memories. Default 0.8. */
  similarity_threshold: number;
  /** Min memories to form a cluster. Default 2. */
  min_cluster_size: number;
  /** Max memories per cluster. Default 10. */
  max_cluster_size: number;
  /** Use LLM for summarization. Auto-detected from OPENAI_API_KEY if not set. */
  use_llm: boolean;
  /** Filter to a specific project. Optional. */
  project?: string;
  /** Project root for MEMORY.md. Optional. */
  project_root?: string;
}

export const DEFAULT_CONFIG: ConsolidatorConfig = {
  decay_threshold: 0.3,
  similarity_threshold: 0.8,
  min_cluster_size: 2,
  max_cluster_size: 10,
  use_llm: !!process.env.OPENAI_API_KEY,
};

// --- Result ---

export interface ConsolidateResult {
  clusters_found: number;
  memories_consolidated: number;
  new_memories_created: number;
  duration_ms: number;
}

// --- Step 1: Find aging memories ---

async function findAgingMemories(
  client: QdrantClient,
  userId: string,
  config: ConsolidatorConfig
): Promise<Memory[]> {
  const all = await scrollMemories(client, {
    user_id: userId,
    status: 'active',
    ...(config.project ? { project: config.project } : {}),
  }, 500);

  return all.filter((m) => decayWeight(m.last_accessed) < config.decay_threshold);
}

// --- Step 2: Cluster by project+type, then by similarity ---

interface Cluster {
  project: string;
  type: MemoryType;
  memories: Memory[];
}

async function clusterMemories(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  memories: Memory[],
  config: ConsolidatorConfig
): Promise<Cluster[]> {
  // Group by project + type
  const groups = new Map<string, Memory[]>();
  for (const mem of memories) {
    const key = `${mem.project}::${mem.type}`;
    const existing = groups.get(key) ?? [];
    existing.push(mem);
    groups.set(key, existing);
  }

  const clusters: Cluster[] = [];

  for (const [key, mems] of groups) {
    if (mems.length < config.min_cluster_size) continue;

    const [project, type] = key.split('::');
    const assigned = new Set<string>();

    // For each unassigned memory, find similar ones
    for (const mem of mems) {
      if (assigned.has(mem.id)) continue;

      const { vector } = await embedder.embed(mem.content);
      const similar = await searchMemories(
        client,
        vector,
        {
          user_id: mem.user_id,
          status: 'active',
          project: mem.project,
          type: mem.type as MemoryType,
          embedding_provider: embedder.provider,
        },
        config.max_cluster_size
      );

      const cluster: Memory[] = [mem];
      assigned.add(mem.id);

      for (const match of similar) {
        if (match.memory.id === mem.id) continue;
        if (assigned.has(match.memory.id)) continue;
        if (match.score < config.similarity_threshold) continue;
        cluster.push(match.memory);
        assigned.add(match.memory.id);
      }

      if (cluster.length >= config.min_cluster_size) {
        clusters.push({ project, type: type as MemoryType, memories: cluster });
      }
    }
  }

  return clusters;
}

// --- Step 3: Summarize cluster ---

async function summarizeCluster(
  memories: Memory[],
  useLlm: boolean
): Promise<string> {
  if (useLlm && process.env.OPENAI_API_KEY) {
    return llmSummarize(memories);
  }
  return deterministicMerge(memories);
}

function deterministicMerge(memories: Memory[]): string {
  // Sort by access_count desc — most-accessed first
  const sorted = [...memories].sort(
    (a, b) => (b.access_count ?? 0) - (a.access_count ?? 0)
  );

  // Use top memory as base, append unique info from others
  const parts: string[] = [sorted[0].content];
  const seen = new Set(sorted[0].content.toLowerCase().split(/\s+/));

  for (const mem of sorted.slice(1)) {
    // Only add if it has substantially new content
    const words = mem.content.toLowerCase().split(/\s+/);
    const newWords = words.filter((w) => !seen.has(w));
    if (newWords.length > words.length * 0.3) {
      parts.push(mem.summary);
      for (const w of words) seen.add(w);
    }
  }

  return parts.join(' | ');
}

async function llmSummarize(memories: Memory[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return deterministicMerge(memories);

  const memoriesText = memories
    .map((m, i) => `${i + 1}. [${m.type}] ${m.content}`)
    .join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You consolidate related memories into a single concise entry. Output only the consolidated text, 1-3 sentences. Preserve key decisions, facts, and context. No preamble.',
        },
        {
          role: 'user',
          content: `Consolidate these ${memories.length} related memories into one:\n\n${memoriesText}`,
        },
      ],
      max_tokens: 200,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    console.error(`LLM summarization failed (${response.status}), falling back to deterministic merge`);
    return deterministicMerge(memories);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content ?? deterministicMerge(memories);
}

// --- Step 4+5: Save consolidated + archive originals ---

async function saveConsolidated(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  cluster: Cluster,
  consolidatedContent: string
): Promise<string> {
  const { vector, provider, model } = await embedder.embed(consolidatedContent);

  const now = new Date().toISOString();
  const totalAccess = cluster.memories.reduce(
    (sum, m) => sum + (m.access_count ?? 0),
    0
  );
  const allTags = [...new Set(cluster.memories.flatMap((m) => m.tags ?? []))];
  const sourceIds = cluster.memories.map((m) => m.id);

  // Generate summary
  const summary =
    consolidatedContent.length > 80
      ? consolidatedContent.slice(0, 77) + '...'
      : consolidatedContent;

  const memory: Memory = {
    id: crypto.randomUUID(),
    user_id: cluster.memories[0].user_id,
    content: consolidatedContent,
    summary,
    type: cluster.type,
    status: 'active',
    project: cluster.project,
    tags: allTags,
    source: 'cleaner',
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: totalAccess,
    last_accessed: now,
    embedding_provider: provider,
    embedding_model: model,
    consolidated_from: sourceIds,
  };

  await upsertMemory(client, memory, vector);

  // Archive originals
  for (const mem of cluster.memories) {
    await updateMemory(client, mem.id, {
      status: 'archived',
      updated_at: now,
    });
  }

  return memory.id;
}

// --- Full Consolidation ---

export async function consolidate(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  userId: string,
  config: Partial<ConsolidatorConfig> = {}
): Promise<ConsolidateResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const start = Date.now();

  // 1. Find aging memories
  const aging = await findAgingMemories(client, userId, cfg);
  if (aging.length < cfg.min_cluster_size) {
    return {
      clusters_found: 0,
      memories_consolidated: 0,
      new_memories_created: 0,
      duration_ms: Date.now() - start,
    };
  }

  // 2. Cluster
  const clusters = await clusterMemories(client, embedder, aging, cfg);

  // 3+4+5. Summarize, save, archive
  let totalConsolidated = 0;
  for (const cluster of clusters) {
    const content = await summarizeCluster(cluster.memories, cfg.use_llm);
    await saveConsolidated(client, embedder, cluster, content);
    totalConsolidated += cluster.memories.length;
  }

  return {
    clusters_found: clusters.length,
    memories_consolidated: totalConsolidated,
    new_memories_created: clusters.length,
    duration_ms: Date.now() - start,
  };
}
