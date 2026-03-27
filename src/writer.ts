import {
  upsertMemory,
  updateMemory,
  searchMemories,
} from './qdrant.js';
import type { createEmbedder } from './embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type {
  Memory,
  MemoryType,
  MemorySource,
} from './types.js';

const DEDUP_THRESHOLD = 0.92;

export interface WriteMemoryInput {
  content: string;
  type: MemoryType;
  project: string;
  tags?: string[];
  source?: MemorySource;
  user_id: string;
}

export interface WriteResult {
  id: string;
  deduplicated: boolean;
  existing_id?: string;
}

export async function writeMemory(
  client: QdrantClient,
  embedder: ReturnType<typeof createEmbedder>,
  input: WriteMemoryInput
): Promise<WriteResult> {
  // 1. Generate embedding
  const { vector, provider, model } = await embedder.embed(input.content);

  // 2. Dedup check — search for >0.92 cosine match
  const candidates = await searchMemories(
    client,
    vector,
    {
      user_id: input.user_id,
      embedding_provider: provider,
      status: 'active',
    },
    3
  );

  const duplicate = candidates.find((c) => c.score > DEDUP_THRESHOLD);

  if (duplicate) {
    // Merge tags and bump access
    const existingTags = duplicate.memory.tags ?? [];
    const newTags = input.tags ?? [];
    const mergedTags = [...new Set([...existingTags, ...newTags])];

    await updateMemory(client, duplicate.memory.id, {
      tags: mergedTags,
      last_accessed: new Date().toISOString(),
      access_count: (duplicate.memory.access_count ?? 0) + 1,
    });

    return {
      id: duplicate.memory.id,
      deduplicated: true,
      existing_id: duplicate.memory.id,
    };
  }

  // 3. Generate summary
  const summary = generateSummary(input.content, input.type);

  // 4. Build memory object
  const now = new Date().toISOString();
  const memory: Memory = {
    id: crypto.randomUUID(),
    user_id: input.user_id,
    content: input.content,
    summary,
    type: input.type,
    status: 'active',
    project: input.project,
    tags: input.tags ?? [],
    source: input.source ?? 'user',
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed: now,
    embedding_provider: provider,
    embedding_model: model,
  };

  // 5. Save to Qdrant
  await upsertMemory(client, memory, vector);

  return { id: memory.id, deduplicated: false };
}

// --- Deterministic summary (no LLM) ---

function generateSummary(content: string, type: MemoryType): string {
  // Truncate to first sentence or 80 chars
  const firstSentence = content.split(/[.!?\n]/)[0].trim();
  const truncated =
    firstSentence.length > 80
      ? firstSentence.slice(0, 77) + '...'
      : firstSentence;

  const prefix = type === 'decision' ? 'Decision:' :
                 type === 'preference' ? 'Preference:' :
                 type === 'task' ? 'Task:' :
                 type === 'context' ? 'Context:' : '';

  return prefix ? `${prefix} ${truncated}` : truncated;
}

// --- Type inference heuristics (for cleaner) ---

const TYPE_PATTERNS: Array<{ pattern: RegExp; type: MemoryType }> = [
  { pattern: /\b(decided|chose|using .+ not .+|switched to|picked|went with)\b/i, type: 'decision' },
  { pattern: /\b(prefer|always|never|like to|rather|favor)\b/i, type: 'preference' },
  { pattern: /\b(TODO|need to|should|fix|must|have to|implement)\b/i, type: 'task' },
  { pattern: /\b(working on|currently|session|today|right now|in progress)\b/i, type: 'context' },
];

export function inferType(content: string): MemoryType {
  for (const { pattern, type } of TYPE_PATTERNS) {
    if (pattern.test(content)) return type;
  }
  return 'fact';
}
