import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbedder } from '../embeddings.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('Embeddings — OpenAI', () => {
  const embedder = createEmbedder({
    provider: 'openai',
    openaiApiKey: 'test-key',
  });

  it('returns correct provider and model metadata', () => {
    expect(embedder.provider).toBe('openai');
    expect(embedder.getModel()).toBe('text-embedding-3-small');
    expect(embedder.getDimensions()).toBe(1536);
  });

  it('calls OpenAI API and returns embedding', async () => {
    const fakeEmbedding = new Array(1536).fill(0.1);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: fakeEmbedding, index: 0 }],
      }),
    });

    const result = await embedder.embed('test text');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(opts.body)).toEqual({
      input: ['test text'],
      model: 'text-embedding-3-small',
    });
    expect(opts.headers.Authorization).toBe('Bearer test-key');

    expect(result.vector).toEqual(fakeEmbedding);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.dimensions).toBe(1536);
  });

  it('handles batch embeddings and preserves order', async () => {
    const v1 = new Array(1536).fill(0.1);
    const v2 = new Array(1536).fill(0.2);
    const v3 = new Array(1536).fill(0.3);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { embedding: v3, index: 2 },
          { embedding: v1, index: 0 },
          { embedding: v2, index: 1 },
        ],
      }),
    });

    const results = await embedder.embedBatch(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(results[0].vector).toEqual(v1);
    expect(results[1].vector).toEqual(v2);
    expect(results[2].vector).toEqual(v3);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key',
    });

    await expect(embedder.embed('test')).rejects.toThrow('OpenAI embeddings failed (401)');
  });

  it('throws when no API key provided', async () => {
    const noKeyEmbedder = createEmbedder({ provider: 'openai' });
    // Clear env var
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await expect(noKeyEmbedder.embed('test')).rejects.toThrow('OpenAI API key required');

    process.env.OPENAI_API_KEY = saved;
  });
});

describe('Embeddings — Ollama', () => {
  const embedder = createEmbedder({ provider: 'ollama' });

  it('returns correct provider and model metadata', () => {
    expect(embedder.provider).toBe('ollama');
    expect(embedder.getModel()).toBe('nomic-embed-text');
    expect(embedder.getDimensions()).toBe(768);
  });

  it('calls Ollama API and returns embedding', async () => {
    const fakeEmbedding = new Array(768).fill(0.2);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [fakeEmbedding] }),
    });

    const result = await embedder.embed('test text');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(opts.body)).toEqual({
      model: 'nomic-embed-text',
      input: 'test text',
    });

    expect(result.vector).toEqual(fakeEmbedding);
    expect(result.provider).toBe('ollama');
    expect(result.dimensions).toBe(768);
  });

  it('throws on Ollama API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Model not found',
    });

    await expect(embedder.embed('test')).rejects.toThrow('Ollama embeddings failed (500)');
  });

  it('uses custom Ollama URL', async () => {
    const custom = createEmbedder({
      provider: 'ollama',
      ollamaUrl: 'http://myserver:11434',
      ollamaModel: 'custom-model',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [new Array(768).fill(0)] }),
    });

    await custom.embed('test');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://myserver:11434/api/embed');
  });
});
