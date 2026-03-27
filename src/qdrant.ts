import { QdrantClient } from '@qdrant/js-client-rest';
import {
  COLLECTION_NAME,
  VECTOR_DIMENSIONS,
  type EmbeddingProvider,
  type Memory,
  type MemoryPayload,
  type MemorySearchFilters,
} from './types.js';

// --- Client ---

export function createQdrantClient(url = 'http://localhost:6333'): QdrantClient {
  return new QdrantClient({ url });
}

// --- Collection Setup ---

export async function ensureCollection(
  client: QdrantClient,
  provider: EmbeddingProvider
): Promise<void> {
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        semantic: {
          size: VECTOR_DIMENSIONS[provider],
          distance: 'Cosine',
        },
      },
    });
  }

  await createPayloadIndexes(client);
}

async function createPayloadIndexes(client: QdrantClient): Promise<void> {
  const keywordFields = [
    'user_id',
    'type',
    'project',
    'status',
    'tags',
    'embedding_provider',
  ];
  const datetimeFields = ['created_at', 'last_accessed'];
  const integerFields = ['access_count'];

  for (const field of keywordFields) {
    await client
      .createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      })
      .catch(() => {
        // Index may already exist — safe to ignore
      });
  }

  for (const field of datetimeFields) {
    await client
      .createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: 'datetime',
        wait: true,
      })
      .catch(() => {});
  }

  for (const field of integerFields) {
    await client
      .createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: 'integer',
        wait: true,
      })
      .catch(() => {});
  }
}

// --- CRUD ---

export async function upsertMemory(
  client: QdrantClient,
  memory: Memory,
  vector: number[]
): Promise<void> {
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [
      {
        id: memory.id,
        vector: { semantic: vector },
        payload: memoryToPayload(memory),
      },
    ],
  });
}

export async function getMemory(
  client: QdrantClient,
  id: string
): Promise<Memory | null> {
  try {
    const results = await client.retrieve(COLLECTION_NAME, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });

    if (results.length === 0) return null;

    const point = results[0];
    return payloadToMemory(point.id as string, point.payload as Record<string, unknown>);
  } catch {
    // Qdrant throws on invalid/non-existent UUID
    return null;
  }
}

export async function updateMemory(
  client: QdrantClient,
  id: string,
  updates: Partial<MemoryPayload>
): Promise<void> {
  updates.updated_at = new Date().toISOString();

  await client.setPayload(COLLECTION_NAME, {
    wait: true,
    points: [id],
    payload: updates as Record<string, unknown>,
  });
}

export async function archiveMemory(
  client: QdrantClient,
  id: string
): Promise<void> {
  await updateMemory(client, id, {
    status: 'archived',
    updated_at: new Date().toISOString(),
  });
}

// --- Search ---

export async function searchMemories(
  client: QdrantClient,
  vector: number[],
  filters: MemorySearchFilters,
  limit = 5,
  withPayloadFields?: string[]
): Promise<Array<{ memory: Memory; score: number }>> {
  const filter = buildFilter(filters);

  const results = await client.search(COLLECTION_NAME, {
    vector: { name: 'semantic', vector },
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    limit,
    with_payload: withPayloadFields
      ? { include: withPayloadFields }
      : true,
    with_vector: false,
  });

  return results.map((r) => ({
    memory: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
    score: r.score,
  }));
}

// --- Recommend (Spreading Activation) ---

export async function recommendMemories(
  client: QdrantClient,
  positiveIds: string[],
  excludeIds: string[],
  limit = 5,
  filters?: MemorySearchFilters
): Promise<Array<{ memory: Memory; score: number }>> {
  const filter = filters ? buildFilter(filters) : {};

  // Add exclusion of already-found IDs
  const mustNot = [
    ...(filter.must_not || []),
    { has_id: excludeIds },
  ];

  const results = await client.recommend(COLLECTION_NAME, {
    positive: positiveIds,
    negative: [],
    strategy: 'average_vector',
    using: 'semantic',
    limit,
    filter: {
      ...filter,
      must_not: mustNot,
    },
    with_payload: true,
    with_vector: false,
  });

  return results.map((r) => ({
    memory: payloadToMemory(r.id as string, r.payload as Record<string, unknown>),
    score: r.score,
  }));
}

// --- Scroll (for GC / batch ops) ---

export async function scrollMemories(
  client: QdrantClient,
  filters: MemorySearchFilters,
  limit = 100
): Promise<Memory[]> {
  const filter = buildFilter(filters);

  const result = await client.scroll(COLLECTION_NAME, {
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    limit,
    with_payload: true,
    with_vector: false,
  });

  return result.points.map((p) =>
    payloadToMemory(p.id as string, p.payload as Record<string, unknown>)
  );
}

// --- Delete (for testing) ---

export async function deletePoints(
  client: QdrantClient,
  ids: string[]
): Promise<void> {
  await client.delete(COLLECTION_NAME, {
    wait: true,
    points: ids,
  });
}

export async function deleteCollection(client: QdrantClient): Promise<void> {
  await client.deleteCollection(COLLECTION_NAME).catch(() => {});
}

// --- Filter Builder ---

export function buildFilter(filters: MemorySearchFilters): Record<string, unknown[]> {
  const must: unknown[] = [];
  const must_not: unknown[] = [];

  if (filters.user_id) {
    must.push({ key: 'user_id', match: { value: filters.user_id } });
  }
  if (filters.project) {
    must.push({ key: 'project', match: { value: filters.project } });
  }
  if (filters.type) {
    must.push({ key: 'type', match: { value: filters.type } });
  }
  if (filters.status) {
    must.push({ key: 'status', match: { value: filters.status } });
  }
  if (filters.embedding_provider) {
    must.push({ key: 'embedding_provider', match: { value: filters.embedding_provider } });
  }
  if (filters.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      must.push({ key: 'tags', match: { value: tag } });
    }
  }
  if (filters.created_after || filters.created_before) {
    const range: Record<string, string> = {};
    if (filters.created_after) range.gte = filters.created_after;
    if (filters.created_before) range.lte = filters.created_before;
    must.push({ key: 'created_at', range });
  }
  if (filters.last_accessed_after || filters.last_accessed_before) {
    const range: Record<string, string> = {};
    if (filters.last_accessed_after) range.gte = filters.last_accessed_after;
    if (filters.last_accessed_before) range.lte = filters.last_accessed_before;
    must.push({ key: 'last_accessed', range });
  }
  if (filters.min_access_count !== undefined || filters.max_access_count !== undefined) {
    const range: Record<string, number> = {};
    if (filters.min_access_count !== undefined) range.gte = filters.min_access_count;
    if (filters.max_access_count !== undefined) range.lte = filters.max_access_count;
    must.push({ key: 'access_count', range });
  }

  const result: Record<string, unknown[]> = {};
  if (must.length > 0) result.must = must;
  if (must_not.length > 0) result.must_not = must_not;
  return result;
}

// --- Helpers ---

function memoryToPayload(memory: Memory): Record<string, unknown> {
  const { id: _id, ...payload } = memory;
  return payload as Record<string, unknown>;
}

function payloadToMemory(id: string, payload: Record<string, unknown>): Memory {
  return { id, ...payload } as Memory;
}
