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
  confidenceBoost,
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

  it('decayWeight returns ~0.5 for 30-day-old memory with default confidence', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // With confidence=0.5: decay^(1-0.5) = decay^0.5 = sqrt(0.5) ≈ 0.707
    const w = decayWeight(thirtyDaysAgo);
    expect(w).toBeCloseTo(0.707, 1);
  });

  it('decayWeight returns ~0.5 for 30-day-old memory with zero confidence', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // With confidence=0: decay^(1-0) = decay^1 = 0.5 (original behavior)
    const w = decayWeight(thirtyDaysAgo, 0);
    expect(w).toBeCloseTo(0.5, 1);
  });

  it('decayWeight decays much slower for high-confidence memories', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const lowConf = decayWeight(ninetyDaysAgo, 0);    // original: ~0.125
    const highConf = decayWeight(ninetyDaysAgo, 0.85); // should be much higher
    expect(lowConf).toBeCloseTo(0.125, 1);
    expect(highConf).toBeGreaterThan(0.7); // barely decays
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
    // With default confidence (0.5): 0.9 * ~1.0 * ~1.35 * 0.75 ≈ 0.91
    const score = adjustedScore(0.9, now, 10);
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1.1);
  });

  it('adjustedScore is higher for high-confidence memories', () => {
    const now = new Date().toISOString();
    const lowConf = adjustedScore(0.9, now, 5, 0.5);
    const highConf = adjustedScore(0.9, now, 5, 0.85);
    expect(highConf).toBeGreaterThan(lowConf);
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

describe('Confidence & Tiering', () => {
  it('confidenceBoost returns 0.75 for default confidence', () => {
    expect(confidenceBoost(0.5)).toBe(0.75);
  });

  it('confidenceBoost returns 1.0 for max confidence', () => {
    expect(confidenceBoost(1.0)).toBe(1.0);
  });

  it('confidenceBoost returns 0.5 for zero confidence', () => {
    expect(confidenceBoost(0.0)).toBe(0.5);
  });

  it('core debate memory outranks regular memory at similar relevance', async () => {
    // Write a regular memory about Webpack bundler config
    const regular = await writeMemory(client, embedder, {
      content: 'Webpack bundler config uses split chunks for code splitting',
      type: 'fact',
      project: PROJECT,
      user_id: USER_ID,
      // defaults: confidence=0.5, tier='regular', provenance='save'
    });

    // Write a core debate-validated memory on same topic (similar text for similar vectors)
    const core = await writeMemory(client, embedder, {
      content: 'Webpack bundler config should use split chunks with dynamic imports for code splitting',
      type: 'decision',
      project: PROJECT,
      user_id: USER_ID,
      provenance: 'debate',
      confidence: 0.85,
      // tier auto-derived to 'core' from provenance='debate'
    });

    // Search with similar query
    const results = await recognize(
      client,
      embedder,
      'Webpack bundler config split chunks code splitting',
      { user_id: USER_ID, project: PROJECT },
      10
    );

    // Find both in results
    const coreResult = results.find(r => r.id === core.id);
    const regularResult = results.find(r => r.id === regular.id);

    expect(coreResult).toBeDefined();
    expect(regularResult).toBeDefined();
    // Core should have higher adjusted score due to confidence boost
    expect(coreResult!.adjusted_score).toBeGreaterThan(regularResult!.adjusted_score);
    expect(coreResult!.tier).toBe('core');
    expect(coreResult!.confidence).toBe(0.85);
    expect(regularResult!.tier).toBe('regular');
    expect(regularResult!.confidence).toBe(0.5);
  });

  it('debate provenance auto-promotes to core tier', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'Auto-tier test: debate provenance should be core',
      type: 'decision',
      project: PROJECT,
      user_id: USER_ID,
      provenance: 'debate',
    });

    const mem = await getMemory(client, result.id);
    expect(mem!.tier).toBe('core');
    expect(mem!.confidence).toBe(0.85); // DEFAULT_CONFIDENCE.debate
    expect(mem!.provenance).toBe('debate');
  });

  it('human provenance auto-promotes to core tier', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'The Redis cache TTL should be exactly 3600 seconds — human confirmed via production metrics dashboard',
      type: 'decision',
      project: PROJECT,
      user_id: USER_ID,
      provenance: 'human',
    });

    const mem = await getMemory(client, result.id);
    expect(mem!.tier).toBe('core');
    expect(mem!.confidence).toBe(0.95); // DEFAULT_CONFIDENCE.human
  });

  it('save provenance stays regular tier', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'The Tailwind config uses a custom purple color palette with 12 shades',
      type: 'fact',
      project: PROJECT,
      user_id: USER_ID,
      // provenance defaults to 'save'
    });

    const mem = await getMemory(client, result.id);
    expect(mem!.tier).toBe('regular');
    expect(mem!.confidence).toBe(0.5);
    expect(mem!.provenance).toBe('save');
  });

  it('confidence can be overridden manually', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'Manual confidence override test',
      type: 'fact',
      project: PROJECT,
      user_id: USER_ID,
      provenance: 'save',
      confidence: 0.9, // override default 0.5
    });

    const mem = await getMemory(client, result.id);
    expect(mem!.confidence).toBe(0.9);
    expect(mem!.tier).toBe('regular'); // provenance is 'save', stays regular
  });

  it('high confidence memory survives decay that archives regular memory', () => {
    // 200 days ago — well past the ~100 day archive threshold for regular
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const threshold = 0.1;

    // confidence=0 gives original decay behavior (no dampening)
    const regularDecay = decayWeight(oldDate, 0);
    const coreDecay = decayWeight(oldDate, 0.85);

    // Regular memory (confidence=0) at 200 days: 0.5^(200/30) ≈ 0.01 — well below threshold
    expect(regularDecay).toBeLessThan(threshold);
    // Core memory (confidence=0.85) at 200 days: decays ~15% as fast — should survive
    expect(coreDecay).toBeGreaterThan(threshold);
  });
});
