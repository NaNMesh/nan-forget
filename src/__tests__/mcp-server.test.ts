import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp/server.js';
import {
  createQdrantClient,
  ensureCollection,
  deleteCollection,
} from '../qdrant.js';

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

describe('MCP Server', () => {
  let client: Client;
  let tempDir: string;
  const qdrant = createQdrantClient();

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nanforget-mcp-'));
    await deleteCollection(qdrant);
    await ensureCollection(qdrant, 'openai');

    const { server } = createServer({
      client: qdrant,
      embedder: createTestEmbedder() as any,
      userId: 'mcp-test-user',
      projectRoot: tempDir,
    });

    // Create linked in-memory transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await deleteCollection(qdrant);
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists all 11 tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_get');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_archive');
    expect(names).toContain('memory_consolidate');
    expect(names).toContain('memory_clean');
    expect(names).toContain('memory_stats');
    expect(names).toContain('memory_health');
    expect(names).toContain('memory_start');
    expect(names).toContain('memory_sync');
    expect(names).toHaveLength(11);
  });

  it('memory_save creates a memory', async () => {
    const result = await client.callTool({
      name: 'memory_save',
      arguments: {
        content: 'We chose Qdrant as the vector database',
        type: 'decision',
        project: 'mcp-test',
        tags: ['database', 'vector'],
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Memory saved:');
  });

  it('memory_save deduplicates identical content', async () => {
    const result = await client.callTool({
      name: 'memory_save',
      arguments: {
        content: 'We chose Qdrant as the vector database',
        type: 'decision',
        project: 'mcp-test',
        tags: ['database'],
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('already exists');
  });

  let savedId: string;

  it('memory_search finds saved memories', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: {
        query: 'which vector database are we using?',
        project: 'mcp-test',
        depth: 2,
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Qdrant');

    // Extract ID for subsequent tests
    const idMatch = text.match(/id: ([\w-]+)/);
    expect(idMatch).toBeTruthy();
    savedId = idMatch![1];
  });

  it('memory_get retrieves by ID', async () => {
    const result = await client.callTool({
      name: 'memory_get',
      arguments: { id: savedId },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.content).toContain('Qdrant');
    expect(parsed.project).toBe('mcp-test');
  });

  it('memory_get returns error for unknown ID', async () => {
    const result = await client.callTool({
      name: 'memory_get',
      arguments: { id: 'nonexistent-id' },
    });

    expect(result.isError).toBe(true);
  });

  it('memory_update changes content', async () => {
    const result = await client.callTool({
      name: 'memory_update',
      arguments: {
        id: savedId,
        tags: ['database', 'vector', 'qdrant'],
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Memory updated');
  });

  it('memory_archive soft-deletes a memory', async () => {
    // Save a memory to archive
    const saveResult = await client.callTool({
      name: 'memory_save',
      arguments: {
        content: 'Temporary fact that should be archived',
        type: 'fact',
        project: 'mcp-test',
        tags: ['temp'],
      },
    });

    const saveText = (saveResult.content as { type: string; text: string }[])[0].text;
    const archiveId = saveText.match(/Memory saved: ([\w-]+)/)![1];

    const result = await client.callTool({
      name: 'memory_archive',
      arguments: { id: archiveId },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Memory archived');

    // Verify it's actually archived
    const getResult = await client.callTool({
      name: 'memory_get',
      arguments: { id: archiveId },
    });
    const parsed = JSON.parse((getResult.content as { type: string; text: string }[])[0].text);
    expect(parsed.status).toBe('archived');
  });

  it('memory_search with depth 1 returns blur results', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: {
        query: 'vector database',
        depth: 1,
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    // Depth 1 = recognition only, should have score info
    expect(text.length).toBeGreaterThan(0);
  });

  it('memory_sync returns lightweight handshake', async () => {
    const result = await client.callTool({
      name: 'memory_sync',
      arguments: {},
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('NaN Forget');
    expect(text).toContain('Services');
    expect(text).toContain('Memory Bank');
    expect(text).toContain('Ready');
  });

  it('memory_health returns service status', async () => {
    const result = await client.callTool({
      name: 'memory_health',
      arguments: {},
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Qdrant');
    expect(text).toContain('Ollama');
    expect(text).toContain('REST API');
  });

  it('memory_stats returns counts', async () => {
    const result = await client.callTool({
      name: 'memory_stats',
      arguments: {},
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('Active');
    expect(text).toContain('By type');
    expect(text).toContain('By project');
  });
});
