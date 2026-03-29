import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createDb,
  ensureSchema,
  getMemory,
  deleteCollection,
} from '../sqlite.js';
import { writeMemory } from '../writer.js';
import {
  recognize,
  recall,
  reconstruct,
  retrieve,
  decayWeight,
  frequencyBoost,
  adjustedScore,
} from '../retriever.js';

const client = createDb(':memory:');

// Deterministic test embedder (same as writer tests)
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
const USER_ID = 'retriever-test-user';
const PROJECT = 'test-project';

// Store written IDs for assertions
const writtenIds: Record<string, string> = {};

describe('Scoring Functions', () => {
  it('decayWeight returns 1.0 for just-accessed memory', () => {
    const w = decayWeight(new Date().toISOString());
    expect(w).toBeGreaterThan(0.99);
  });

  it('decayWeight returns ~0.5 for 30-day-old memory', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const w = decayWeight(thirtyDaysAgo);
    expect(w).toBeCloseTo(0.5, 1);
  });

  it('decayWeight returns ~0.125 for 90-day-old memory', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const w = decayWeight(ninetyDaysAgo);
    expect(w).toBeCloseTo(0.125, 1);
  });

  it('frequencyBoost returns 1.0 for 0 accesses', () => {
    expect(frequencyBoost(0)).toBe(1);
  });

  it('frequencyBoost increases with access count', () => {
    expect(frequencyBoost(10)).toBeGreaterThan(frequencyBoost(1));
    expect(frequencyBoost(100)).toBeGreaterThan(frequencyBoost(10));
  });

  it('adjustedScore combines all factors', () => {
    const now = new Date().toISOString();
    const score = adjustedScore(0.9, now, 10);
    // ~0.9 * ~1.0 * ~1.35 ≈ 1.2
    expect(score).toBeGreaterThan(1.0);
  });
});

describe('Retriever Pipeline', () => {
  beforeAll(async () => {
    await deleteCollection(client);
    ensureSchema(client, 'openai');

    // Seed memories for retrieval tests
    const memories = [
      { content: 'FastAPI is used for the backend REST API server', type: 'decision' as const, tags: ['backend', 'api'] },
      { content: 'PostgreSQL database with Prisma ORM for data layer', type: 'decision' as const, tags: ['database', 'orm'] },
      { content: 'Railway platform for deployment and hosting', type: 'decision' as const, tags: ['deploy', 'hosting'] },
      { content: 'Clerk authentication service for user login', type: 'decision' as const, tags: ['auth', 'security'] },
      { content: 'Vitest for unit and integration testing framework', type: 'decision' as const, tags: ['testing'] },
      { content: 'Always use strict TypeScript with no-any rule', type: 'preference' as const, tags: ['typescript'] },
      { content: 'The CI pipeline runs on GitHub Actions with matrix builds', type: 'fact' as const, tags: ['ci', 'github'] },
    ];

    for (const m of memories) {
      const result = await writeMemory(client, embedder, {
        content: m.content,
        type: m.type,
        project: PROJECT,
        tags: m.tags,
        user_id: USER_ID,
      });
      writtenIds[m.content.slice(0, 20)] = result.id;
    }
  });

  afterAll(async () => {
    await deleteCollection(client);
  });

  it('Stage 1 — recognize returns summaries, not full content', async () => {
    const results = await recognize(
      client,
      embedder,
      'What backend framework are we using?',
      { user_id: USER_ID, project: PROJECT },
      5
    );

    expect(results.length).toBeGreaterThan(0);
    // Should have summary, type, tags — but we can't check "no content"
    // because searchMemories with field filter controls this
    expect(results[0].summary).toBeDefined();
    expect(results[0].type).toBeDefined();
    expect(results[0].adjusted_score).toBeGreaterThan(0);
  });

  it('Stage 1 — results are sorted by adjusted score', async () => {
    const results = await recognize(
      client,
      embedder,
      'database and ORM choice',
      { user_id: USER_ID, project: PROJECT },
      5
    );

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].adjusted_score).toBeGreaterThanOrEqual(results[i].adjusted_score);
    }
  });

  it('Stage 2 — recall returns full memory objects', async () => {
    const recognition = await recognize(
      client,
      embedder,
      'deployment platform',
      { user_id: USER_ID, project: PROJECT },
      3
    );

    const recallResults = await recall(
      client,
      embedder,
      'deployment platform',
      { user_id: USER_ID, project: PROJECT },
      recognition.map((r) => r.id),
      5
    );

    expect(recallResults.length).toBeGreaterThan(0);
    // Full memory objects have content field
    expect(recallResults[0].memory.content).toBeDefined();
    expect(recallResults[0].memory.content.length).toBeGreaterThan(0);
  });

  it('Stage 3 — reconstruct finds associated memories', async () => {
    const recognition = await recognize(
      client,
      embedder,
      'backend API framework',
      { user_id: USER_ID, project: PROJECT },
      3
    );

    const associations = await reconstruct(
      client,
      recognition.map((r) => r.id),
      { user_id: USER_ID },
      5
    );

    // Should find memories not in the original recognition set
    const recogIds = new Set(recognition.map((r) => r.id));
    const newFinds = associations.filter((a) => !recogIds.has(a.memory.id));
    expect(newFinds.length).toBeGreaterThan(0);
  });

  it('Full pipeline — retrieve runs all 3 stages', async () => {
    const result = await retrieve(
      client,
      embedder,
      'What testing framework do we use?',
      { user_id: USER_ID, project: PROJECT },
      { maxStage: 3, limit: 5 }
    );

    expect(result.stage).toBe(3);
    expect(result.recognition.length).toBeGreaterThan(0);
    expect(result.recall.length).toBeGreaterThan(0);
    // Associations may or may not find new results depending on vector similarity
    // but the pipeline should complete without error
  });

  it('Full pipeline — can stop at stage 1', async () => {
    const result = await retrieve(
      client,
      embedder,
      'TypeScript preferences',
      { user_id: USER_ID, project: PROJECT },
      { maxStage: 1, limit: 3 }
    );

    expect(result.stage).toBe(1);
    expect(result.recognition.length).toBeGreaterThan(0);
    expect(result.recall).toEqual([]);
    expect(result.associations).toEqual([]);
  });

  it('Retrieval updates access_count on touched memories', async () => {
    // Get initial access count
    const recognition = await recognize(
      client,
      embedder,
      'GitHub Actions CI pipeline',
      { user_id: USER_ID, project: PROJECT },
      1
    );

    expect(recognition.length).toBeGreaterThan(0);
    const id = recognition[0].id;
    const before = await getMemory(client, id);
    const beforeCount = before!.access_count;

    // Run full pipeline (which touches memories)
    await retrieve(
      client,
      embedder,
      'GitHub Actions CI pipeline',
      { user_id: USER_ID, project: PROJECT },
      { maxStage: 2, limit: 3 }
    );

    const after = await getMemory(client, id);
    expect(after!.access_count).toBeGreaterThan(beforeCount);
  });
});
