import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createQdrantClient,
  ensureCollection,
  getMemory,
  deleteCollection,
} from '../qdrant.js';
import { createEmbedder } from '../embeddings.js';
import { writeMemory, inferType } from '../writer.js';

const client = createQdrantClient();

// Use a real-ish embedder that produces deterministic vectors from content
// We mock by hashing content into a consistent vector
function createTestEmbedder() {
  function hashToVector(text: string): number[] {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 1536] += text.charCodeAt(i) / 1000;
    }
    // Normalize
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

describe('Memory Writer', () => {
  beforeAll(async () => {
    await deleteCollection(client);
    await ensureCollection(client, 'openai');
  });

  afterAll(async () => {
    await deleteCollection(client);
  });

  it('writes a new memory and returns id', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'Using FastAPI not Django for the backend',
      type: 'decision',
      project: 'nan-mesh',
      tags: ['backend'],
      user_id: 'test-user',
    });

    expect(result.id).toBeDefined();
    expect(result.deduplicated).toBe(false);

    const stored = await getMemory(client, result.id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe('Using FastAPI not Django for the backend');
    expect(stored!.type).toBe('decision');
    expect(stored!.summary).toMatch(/^Decision:/);
    expect(stored!.embedding_provider).toBe('openai');
    expect(stored!.embedding_model).toBe('text-embedding-3-small');
  });

  it('deduplicates identical content', async () => {
    const first = await writeMemory(client, embedder, {
      content: 'Deploy on Railway not Vercel',
      type: 'decision',
      project: 'nan-mesh',
      tags: ['deploy'],
      user_id: 'test-user',
    });

    const second = await writeMemory(client, embedder, {
      content: 'Deploy on Railway not Vercel',
      type: 'decision',
      project: 'nan-mesh',
      tags: ['deploy', 'infra'],
      user_id: 'test-user',
    });

    expect(second.deduplicated).toBe(true);
    expect(second.existing_id).toBe(first.id);

    // Tags should be merged
    const stored = await getMemory(client, first.id);
    expect(stored!.tags).toContain('deploy');
    expect(stored!.tags).toContain('infra');
    // Access count bumped
    expect(stored!.access_count).toBe(1);
  });

  it('does not dedup different content', async () => {
    const first = await writeMemory(client, embedder, {
      content: 'PostgreSQL for the main database',
      type: 'decision',
      project: 'nan-mesh',
      user_id: 'test-user',
    });

    const second = await writeMemory(client, embedder, {
      content: 'Redis for caching layer',
      type: 'decision',
      project: 'nan-mesh',
      user_id: 'test-user',
    });

    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  it('generates summary with type prefix', async () => {
    const result = await writeMemory(client, embedder, {
      content: 'Vim keybindings everywhere including VS Code and terminal multiplexer tmux',
      type: 'preference',
      project: 'global',
      user_id: 'test-user-prefix',
    });

    expect(result.deduplicated).toBe(false);
    const stored = await getMemory(client, result.id);
    expect(stored!.summary).toMatch(/^Preference:/);
    expect(stored!.summary).toContain('Vim keybindings');
  });

  it('truncates long summaries', async () => {
    const longContent =
      'This is a very long sentence that goes on and on and on and describes something in great detail about the architecture of the system and all its components';
    const result = await writeMemory(client, embedder, {
      content: longContent,
      type: 'fact',
      project: 'test',
      user_id: 'test-user',
    });

    const stored = await getMemory(client, result.id);
    expect(stored!.summary.length).toBeLessThanOrEqual(85); // no prefix for fact + truncation
  });
});

describe('Type Inference Heuristics', () => {
  it('detects decisions', () => {
    expect(inferType('Decided to use FastAPI')).toBe('decision');
    expect(inferType('Using Postgres not MySQL')).toBe('decision');
    expect(inferType('Switched to pnpm from npm')).toBe('decision');
    expect(inferType('Chose Railway for deploys')).toBe('decision');
  });

  it('detects preferences', () => {
    expect(inferType('I prefer dark mode')).toBe('preference');
    expect(inferType('Always use strict TypeScript')).toBe('preference');
    expect(inferType('Never use var in JavaScript')).toBe('preference');
  });

  it('detects tasks', () => {
    expect(inferType('TODO: fix the auth middleware')).toBe('task');
    expect(inferType('Need to update the CI pipeline')).toBe('task');
    expect(inferType('Should refactor the router')).toBe('task');
  });

  it('detects context', () => {
    expect(inferType('Currently working on the auth flow')).toBe('context');
    expect(inferType('Working on MCP integration today')).toBe('context');
    expect(inferType('This session is about testing')).toBe('context');
  });

  it('defaults to fact', () => {
    expect(inferType('The API runs on port 8080')).toBe('fact');
    expect(inferType('PostgreSQL version 15')).toBe('fact');
  });
});
