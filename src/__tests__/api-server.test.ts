import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../api/server.js';
import {
  createDb,
  deleteCollection,
  ensureSchema,
  getMemory,
} from '../sqlite.js';

function createTestEmbedder() {
  function hashToVector(text: string): number[] {
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 1536] += text.charCodeAt(i) / 1000;
    }
    const mag = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
    return vec.map((value) => value / (mag || 1));
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
      texts.map((text) => ({
        vector: hashToVector(text),
        provider: 'openai' as const,
        model: 'text-embedding-3-small',
        dimensions: 1536,
      })),
  };
}

describe('REST API Server', () => {
  const client = createDb(':memory:');
  const embedder = createTestEmbedder();
  let tempDir: string;
  let baseUrl: string;
  let server: ReturnType<typeof startApiServer>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nanforget-api-'));
    await deleteCollection(client);
    ensureSchema(client, 'openai');

    server = startApiServer(0, {
      client,
      embedder: embedder as any,
      userId: 'api-test-user',
      projectRoot: tempDir,
    });

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    await deleteCollection(client);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('POST /memories saves structured fields', async () => {
    const response = await fetch(`${baseUrl}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'We store auth context in nan-forget',
        type: 'decision',
        project: 'api-test',
        tags: ['auth'],
        problem: 'Auth decisions were getting lost between sessions',
        solution: 'Persist auth context as structured memory',
        files: ['src/auth.ts'],
        concepts: ['auth', 'memory'],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    const memory = getMemory(client, body.id);

    expect(memory?.problem).toContain('lost between sessions');
    expect(memory?.solution).toContain('structured memory');
    expect(memory?.files).toEqual(['src/auth.ts']);
    expect(memory?.concepts).toEqual(['auth', 'memory']);
  });

  it('POST /memories/checkpoint saves completed-task context', async () => {
    const response = await fetch(`${baseUrl}/memories/checkpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_summary: 'Added Codex fallback path',
        problem: 'Codex did not have memory tool parity',
        solution: 'Added CLI and REST checkpoint support',
        files: ['src/cli/index.ts', 'src/api/server.ts'],
        concepts: ['codex', 'memory', 'checkpoint'],
        project: 'api-test',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    const memory = getMemory(client, body.id);

    expect(memory?.tags).toContain('checkpoint');
    expect(memory?.content).toContain('Problem: Codex did not have memory tool parity');
    expect(memory?.concepts).toEqual(['codex', 'memory', 'checkpoint']);
  });

  it('GET /memories/instructions includes checkpoint and CLI fallback guidance', async () => {
    const response = await fetch(`${baseUrl}/memories/instructions`);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain('/memories/checkpoint');
    expect(text).toContain('nan-forget checkpoint');
    expect(text).toContain('nan-forget sync');
  });
});
