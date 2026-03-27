import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createQdrantClient,
  ensureCollection,
  deleteCollection,
  getMemory,
  updateMemory,
  scrollMemories,
} from '../qdrant.js';
import { writeMemory } from '../writer.js';
import {
  gcDecayed,
  gcExpired,
  gcDuplicates,
  syncMemoryMd,
  clean,
  DEFAULT_CONFIG,
} from '../cleaner.js';
import { read as readMemoryMd } from '../memory-md.js';

const client = createQdrantClient();
const USER_ID = 'cleaner-test-user';

function createTestEmbedder() {
  function hashToVector(text: string): number[] {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 1536] += text.charCodeAt(i) / 1000;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (mag || 1));
  }

  return {
    provider: 'openai' as const,
    getModel: () => 'text-embedding-3-small',
    getDimensions: () => 1536,
    embed: async (text: string) => ({
      vector: hashToVector(text),
      provider: 'openai' as const,
      model: 'text-embedding-3-small',
      dimensions: 1536,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        vector: hashToVector(t),
        provider: 'openai' as const,
        model: 'text-embedding-3-small',
        dimensions: 1536,
      })),
  };
}

const embedder = createTestEmbedder();

describe('Cleaner', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nanforget-cleaner-'));
    await deleteCollection(client);
    await ensureCollection(client, 'openai');
  });

  afterAll(async () => {
    await deleteCollection(client);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('gcDecayed', () => {
    it('archives memories with low decay weight', async () => {
      // Write a memory, then backdate its last_accessed to 200 days ago
      const result = await writeMemory(client, embedder, {
        content: 'Ancient memory about old framework',
        type: 'decision',
        project: 'old-proj',
        tags: ['old'],
        user_id: USER_ID,
      });

      const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
      await updateMemory(client, result.id, {
        last_accessed: oldDate,
        access_count: 0,
      });

      const archived = await gcDecayed(client, USER_ID, {
        ...DEFAULT_CONFIG,
        decay_threshold: 0.1,
      });

      expect(archived).toContain(result.id);

      const mem = await getMemory(client, result.id);
      expect(mem!.status).toBe('archived');
    });

    it('keeps recent memories', async () => {
      const result = await writeMemory(client, embedder, {
        content: 'Fresh memory about new feature',
        type: 'fact',
        project: 'new-proj',
        tags: ['fresh'],
        user_id: USER_ID,
      });

      const archived = await gcDecayed(client, USER_ID, {
        ...DEFAULT_CONFIG,
        decay_threshold: 0.1,
      });

      expect(archived).not.toContain(result.id);

      const mem = await getMemory(client, result.id);
      expect(mem!.status).toBe('active');
    });
  });

  describe('gcExpired', () => {
    it('archives expired memories', async () => {
      const result = await writeMemory(client, embedder, {
        content: 'Temporary task that expired',
        type: 'task',
        project: 'proj',
        tags: ['temp'],
        user_id: USER_ID,
      });

      const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
      await updateMemory(client, result.id, { expires_at: pastDate });

      const archived = await gcExpired(client, USER_ID, DEFAULT_CONFIG);
      expect(archived).toContain(result.id);
    });

    it('keeps non-expired memories', async () => {
      const result = await writeMemory(client, embedder, {
        content: 'Task with future expiry',
        type: 'task',
        project: 'proj',
        tags: [],
        user_id: USER_ID,
      });

      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await updateMemory(client, result.id, { expires_at: futureDate });

      const archived = await gcExpired(client, USER_ID, DEFAULT_CONFIG);
      expect(archived).not.toContain(result.id);
    });
  });

  describe('gcDuplicates', () => {
    it('archives near-duplicate memories, keeps higher access_count', async () => {
      // Fresh collection to isolate
      await deleteCollection(client);
      await ensureCollection(client, 'openai');

      // Use upsertMemory directly to bypass writer dedup
      const { upsertMemory } = await import('../qdrant.js');

      const now = new Date().toISOString();
      const base = {
        user_id: USER_ID,
        type: 'decision' as const,
        status: 'active' as const,
        project: 'dedup-proj',
        tags: ['db'],
        source: 'user' as const,
        created_at: now,
        updated_at: now,
        expires_at: null,
        last_accessed: now,
        embedding_provider: 'openai' as const,
        embedding_model: 'text-embedding-3-small',
      };

      const content1 = 'We use PostgreSQL for the database layer';
      const content2 = 'We use PostgreSQL for the database layer setup';
      const { vector: v1 } = await embedder.embed(content1);
      const { vector: v2 } = await embedder.embed(content2);

      const mem1 = { ...base, id: crypto.randomUUID(), content: content1, summary: content1, access_count: 10 };
      const mem2 = { ...base, id: crypto.randomUUID(), content: content2, summary: content2, access_count: 1 };

      await upsertMemory(client, mem1, v1);
      await upsertMemory(client, mem2, v2);

      const archived = await gcDuplicates(client, embedder, USER_ID, {
        ...DEFAULT_CONFIG,
        dedup_similarity: 0.85, // lower threshold for test embedder
      });

      // One of them should be archived (the one with lower access_count)
      expect(archived.length).toBeGreaterThan(0);
      expect(archived).toContain(mem2.id);
      expect(archived).not.toContain(mem1.id);
    });
  });

  describe('syncMemoryMd', () => {
    it('writes top memories to MEMORY.md', async () => {
      // Fresh collection for this test
      await deleteCollection(client);
      await ensureCollection(client, 'openai');

      // Write a fresh active memory
      await writeMemory(client, embedder, {
        content: 'Sync test memory for MEMORY.md',
        type: 'fact',
        project: 'sync-proj',
        tags: ['sync'],
        user_id: USER_ID,
      });

      // Verify it's there and inspect what syncMemoryMd will see
      const active = await scrollMemories(client, { user_id: USER_ID, status: 'active' }, 10);
      expect(active.length).toBeGreaterThan(0);
      // Check the memory has required fields for MEMORY.md sync
      expect(active[0].summary).toBeDefined();
      expect(active[0].project).toBeDefined();

      await syncMemoryMd(client, USER_ID, {
        ...DEFAULT_CONFIG,
        project_root: tempDir,
      });

      const state = await readMemoryMd(tempDir);
      expect(state.lines.length).toBeGreaterThan(0);

      const fileContent = await readFile(join(tempDir, 'MEMORY.md'), 'utf-8');
      expect(fileContent).toContain('# NaN Forget');
    });
  });

  describe('full clean', () => {
    it('runs all steps and returns result', async () => {
      const result = await clean(client, embedder, USER_ID, {
        project_root: tempDir,
      });

      expect(result.archived_decayed).toBeGreaterThanOrEqual(0);
      expect(result.archived_expired).toBeGreaterThanOrEqual(0);
      expect(result.archived_deduped).toBeGreaterThanOrEqual(0);
      expect(result.memory_md_synced).toBe(true);
      expect(result.duration_ms).toBeGreaterThan(0);
    });
  });
});
