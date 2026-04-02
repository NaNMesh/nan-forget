import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  ensureSchema,
  deleteCollection,
} from '../sqlite.js';

// Set env vars BEFORE importing CLI (it reads env at getClient() call time)
const tempDir = await mkdtemp(join(tmpdir(), 'nanforget-cli-'));

// We can't easily mock the embedder through env vars, so we'll test
// the CLI commands that don't need embeddings (get, list, stats, export)
// and test the full flow by setting up data via the writer directly.

import { writeMemory } from '../writer.js';
import {
  cmdAdd,
  cmdSearch,
  cmdSync,
  cmdCheckpoint,
  cmdGet,
  cmdList,
  cmdUpdate,
  cmdArchive,
  cmdClean,
  cmdStats,
  cmdExport,
  run,
  setTestDb,
  setTestEmbedder,
} from '../cli/index.js';

const client = createDb(':memory:');
setTestDb(client);

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
setTestEmbedder(embedder as any);

let seededId: string;

describe('CLI Commands', () => {
  beforeAll(async () => {
    await deleteCollection(client);
    ensureSchema(client, 'openai');

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

  it('cmdAdd saves structured fields', async () => {
    const output = await cmdAdd([
      '--type', 'decision',
      '--project', 'cli-test',
      '--problem', 'The auth layer kept losing cross-session context',
      '--solution', 'Persisted auth decisions as structured memories',
      '--files', 'src/auth.ts,src/session.ts',
      '--concepts', 'auth,memory',
      'We store auth decisions in nan-forget',
    ]);

    expect(output).toContain('saved');
    const id = output.match(/saved: ([\w-]+)/i)?.[1];
    expect(id).toBeTruthy();

    const saved = JSON.parse(await cmdGet([id!]));
    expect(saved.problem).toContain('cross-session context');
    expect(saved.solution).toContain('structured memories');
    expect(saved.files).toEqual(['src/auth.ts', 'src/session.ts']);
    expect(saved.concepts).toEqual(['auth', 'memory']);
  });

  it('cmdCheckpoint saves task completion context', async () => {
    const output = await cmdCheckpoint([
      '--summary', 'Added Codex fallback commands',
      '--problem', 'Codex sessions did not have memory tool parity',
      '--solution', 'Added sync and checkpoint CLI commands plus structured add support',
      '--files', 'src/cli/index.ts,AGENTS.md',
      '--concepts', 'codex,memory,cli',
      '--project', 'cli-test',
    ]);

    expect(output).toContain('Checkpoint saved');
    const id = output.match(/saved: ([\w-]+)/i)?.[1];
    expect(id).toBeTruthy();

    const saved = JSON.parse(await cmdGet([id!]));
    expect(saved.tags).toContain('checkpoint');
    expect(saved.problem).toContain('tool parity');
    expect(saved.concepts).toEqual(['codex', 'memory', 'cli']);
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

  it('cmdSync prints handshake context', async () => {
    const output = await cmdSync([]);
    expect(output).toContain('NaN Forget — Ready');
    expect(output).toContain('Memory Bank');
    expect(output).toContain('Ready');
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
