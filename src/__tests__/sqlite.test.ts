import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createDb,
  ensureSchema,
  upsertMemory,
  getMemory,
  updateMemory,
  archiveMemory,
  searchMemories,
  recommendMemories,
  scrollMemories,
  deleteCollection,
} from '../sqlite.js';
import type { Memory } from '../types.js';

const client = createDb(':memory:');
const VECTOR_SIZE = 1536;

// Fixed UUIDs for deterministic tests
const IDS = {
  upsert1: '00000000-0000-0000-0000-000000000001',
  update1: '00000000-0000-0000-0000-000000000002',
  archive1: '00000000-0000-0000-0000-000000000003',
  search1: '00000000-0000-0000-0000-000000000011',
  search2: '00000000-0000-0000-0000-000000000012',
  search3: '00000000-0000-0000-0000-000000000013',
  dedup1: '00000000-0000-0000-0000-000000000021',
  rec1: '00000000-0000-0000-0000-000000000031',
  rec2: '00000000-0000-0000-0000-000000000032',
  rec3: '00000000-0000-0000-0000-000000000033',
  recFar: '00000000-0000-0000-0000-000000000034',
  gcOld: '00000000-0000-0000-0000-000000000041',
  gcRecent: '00000000-0000-0000-0000-000000000042',
};

function fakeVector(seed = 0): number[] {
  return new Array(VECTOR_SIZE).fill(0).map((_, i) => Math.sin(seed + i) * 0.5);
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    user_id: 'test-user',
    content: 'Using FastAPI not Django for the backend',
    summary: 'FastAPI over Django decision',
    type: 'decision',
    status: 'active',
    project: 'nan-mesh',
    tags: ['backend', 'framework'],
    source: 'user',
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed: now,
    embedding_provider: 'openai',
    embedding_model: 'text-embedding-3-small',
    ...overrides,
  };
}

describe('SQLite Storage Layer', () => {
  beforeAll(async () => {
    deleteCollection(client);
    ensureSchema(client, 'openai');
  });

  afterAll(async () => {
    deleteCollection(client);
  });

  it('creates schema correctly', async () => {
    // Schema was created in beforeAll — just verify we can query
    const result = searchMemories(client, fakeVector(0), { status: 'active' }, 1);
    expect(Array.isArray(result)).toBe(true);
  });

  it('upserts and retrieves a memory', async () => {
    const mem = makeMemory({ id: IDS.upsert1 });
    upsertMemory(client, mem, fakeVector(1));

    const result = getMemory(client, IDS.upsert1);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Using FastAPI not Django for the backend');
    expect(result!.type).toBe('decision');
    expect(result!.tags).toEqual(['backend', 'framework']);
  });

  it('returns null for non-existent memory', async () => {
    const result = getMemory(client, '99999999-9999-9999-9999-999999999999');
    expect(result).toBeNull();
  });

  it('updates memory payload fields', async () => {
    const mem = makeMemory({ id: IDS.update1 });
    upsertMemory(client, mem, fakeVector(2));

    updateMemory(client, IDS.update1, {
      content: 'Switched to Django actually',
      tags: ['backend', 'framework', 'changed'],
      access_count: 5,
    });

    const result = getMemory(client, IDS.update1);
    expect(result!.content).toBe('Switched to Django actually');
    expect(result!.tags).toContain('changed');
    expect(result!.access_count).toBe(5);
  });

  it('archives a memory', async () => {
    const mem = makeMemory({ id: IDS.archive1 });
    upsertMemory(client, mem, fakeVector(3));

    archiveMemory(client, IDS.archive1);

    const result = getMemory(client, IDS.archive1);
    expect(result!.status).toBe('archived');
  });

  it('searches with vector + filters', async () => {
    const mem1 = makeMemory({ id: IDS.search1, project: 'project-a', type: 'decision' });
    const mem2 = makeMemory({ id: IDS.search2, project: 'project-a', type: 'fact' });
    const mem3 = makeMemory({ id: IDS.search3, project: 'project-b', type: 'decision' });

    upsertMemory(client, mem1, fakeVector(10));
    upsertMemory(client, mem2, fakeVector(11));
    upsertMemory(client, mem3, fakeVector(12));

    const results = searchMemories(
      client,
      fakeVector(10),
      { project: 'project-a', status: 'active' },
      10
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.memory.project === 'project-a')).toBe(true);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('search returns high cosine score for identical vector (dedup detection)', async () => {
    const mem = makeMemory({ id: IDS.dedup1, content: 'exact same content' });
    upsertMemory(client, mem, fakeVector(20));

    const results = searchMemories(client, fakeVector(20), { status: 'active' }, 5);
    const match = results.find((r) => r.memory.id === IDS.dedup1);
    expect(match).toBeDefined();
    expect(match!.score).toBeGreaterThan(0.99);
  });

  it('recommends related memories (spreading activation)', async () => {
    const base = fakeVector(100);
    const similar1 = base.map((v) => v + 0.01);
    const similar2 = base.map((v) => v + 0.02);
    const different = fakeVector(999);

    upsertMemory(client, makeMemory({ id: IDS.rec1 }), base);
    upsertMemory(client, makeMemory({ id: IDS.rec2 }), similar1);
    upsertMemory(client, makeMemory({ id: IDS.rec3 }), similar2);
    upsertMemory(client, makeMemory({ id: IDS.recFar }), different);

    const results = recommendMemories(
      client,
      [IDS.rec1],
      [IDS.rec1],
      3,
      { status: 'active' }
    );

    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(IDS.rec2);
    expect(ids).toContain(IDS.rec3);
  });

  it('scrolls memories with filters (for GC)', async () => {
    const old = makeMemory({
      id: IDS.gcOld,
      last_accessed: '2024-01-01T00:00:00Z',
      access_count: 1,
    });
    const recent = makeMemory({
      id: IDS.gcRecent,
      last_accessed: new Date().toISOString(),
      access_count: 50,
    });

    upsertMemory(client, old, fakeVector(200));
    upsertMemory(client, recent, fakeVector(201));

    const stale = scrollMemories(client, {
      last_accessed_before: '2025-01-01T00:00:00Z',
      max_access_count: 3,
    });

    const ids = stale.map((m) => m.id);
    expect(ids).toContain(IDS.gcOld);
    expect(ids).not.toContain(IDS.gcRecent);
  });
});
