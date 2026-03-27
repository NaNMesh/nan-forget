import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createQdrantClient,
  ensureCollection,
  deleteCollection,
} from '../qdrant.js';

// Set env vars BEFORE importing CLI (it reads env at getClient() call time)
const tempDir = await mkdtemp(join(tmpdir(), 'nanforget-cli-'));

// We can't easily mock the embedder through env vars, so we'll test
// the CLI commands that don't need embeddings (get, list, stats, export)
// and test the full flow by setting up data via the writer directly.

import { writeMemory } from '../writer.js';
import {
  cmdAdd,
  cmdSearch,
  cmdGet,
  cmdList,
  cmdUpdate,
  cmdArchive,
  cmdClean,
  cmdStats,
  cmdExport,
  run,
} from '../cli/index.js';

const client = createQdrantClient();

// Test embedder for seeding data
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
const USER_ID = 'default'; // CLI default

let seededId: string;

describe('CLI Commands', () => {
  beforeAll(async () => {
    await deleteCollection(client);
    await ensureCollection(client, 'openai');

    // Seed some memories via writer (bypasses CLI's embedder requirement)
    const r = await writeMemory(client, embedder, {
      content: 'We deploy the API on Railway with auto-scaling',
      type: 'decision',
      project: 'cli-test',
      tags: ['deploy', 'railway'],
      user_id: USER_ID,
    });
    seededId = r.id;

    await writeMemory(client, embedder, {
      content: 'TypeScript strict mode with noImplicitAny',
      type: 'preference',
      project: 'cli-test',
      tags: ['typescript'],
      user_id: USER_ID,
    });
  });

  afterAll(async () => {
    await deleteCollection(client);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('cmdGet retrieves a memory by ID', async () => {
    const output = await cmdGet([seededId]);
    const parsed = JSON.parse(output);
    expect(parsed.content).toContain('Railway');
    expect(parsed.type).toBe('decision');
  });

  it('cmdGet returns error for missing ID', async () => {
    const output = await cmdGet([]);
    expect(output).toContain('Error');
  });

  it('cmdGet returns not found for bad ID', async () => {
    const output = await cmdGet(['nonexistent']);
    expect(output).toContain('not found');
  });

  it('cmdList shows active memories', async () => {
    const output = await cmdList([]);
    expect(output).toContain('memories');
    expect(output).toContain('Railway');
  });

  it('cmdList filters by project', async () => {
    const output = await cmdList(['--project', 'cli-test']);
    expect(output).toContain('cli-test');
  });

  it('cmdUpdate changes tags', async () => {
    const output = await cmdUpdate([seededId, '--tags', 'deploy,railway,updated']);
    expect(output).toContain('updated');
  });

  it('cmdArchive archives a memory', async () => {
    // Create a throw-away memory to archive
    const r = await writeMemory(client, embedder, {
      content: 'Temporary memory for archive test',
      type: 'task',
      project: 'cli-test',
      tags: [],
      user_id: USER_ID,
    });

    const output = await cmdArchive([r.id]);
    expect(output).toContain('archived');
  });

  it('cmdStats shows counts', async () => {
    const output = await cmdStats([]);
    expect(output).toContain('Active:');
    expect(output).toContain('By type:');
    expect(output).toContain('By project:');
  });

  it('cmdExport returns JSON array', async () => {
    const output = await cmdExport([]);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('run with --help prints usage', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['--help']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('nan-forget'));
    spy.mockRestore();
  });

  it('run with unknown command shows error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['bogus']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    spy.mockRestore();
    logSpy.mockRestore();
  });
});
