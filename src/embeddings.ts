import { type EmbeddingProvider, VECTOR_DIMENSIONS } from './types.js';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
}

export interface EmbeddingResult {
  vector: number[];
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

const DEFAULTS = {
  openaiModel: 'text-embedding-3-small',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'nomic-embed-text',
} as const;

export function createEmbedder(config: EmbeddingConfig) {
  const provider = config.provider;

  async function embed(text: string): Promise<EmbeddingResult> {
    if (provider === 'openai') {
      return embedOpenAI(text, config);
    }
    return embedOllama(text, config);
  }

  async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (provider === 'openai') {
      return embedOpenAIBatch(texts, config);
    }
    // Ollama doesn't support batch — sequential
    return Promise.all(texts.map((t) => embedOllama(t, config)));
  }

  function getModel(): string {
    return provider === 'openai'
      ? config.openaiModel ?? DEFAULTS.openaiModel
      : config.ollamaModel ?? DEFAULTS.ollamaModel;
  }

  function getDimensions(): number {
    return VECTOR_DIMENSIONS[provider];
  }

  return { embed, embedBatch, getModel, getDimensions, provider };
}

// --- OpenAI ---

async function embedOpenAI(
  text: string,
  config: EmbeddingConfig
): Promise<EmbeddingResult> {
  const results = await embedOpenAIBatch([text], config);
  return results[0];
}

async function embedOpenAIBatch(
  texts: string[],
  config: EmbeddingConfig
): Promise<EmbeddingResult[]> {
  const apiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key required. Set OPENAI_API_KEY env var or pass openaiApiKey in config.'
    );
  }

  const model = config.openaiModel ?? DEFAULTS.openaiModel;

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embeddings failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to maintain order
  const sorted = data.data.sort((a, b) => a.index - b.index);

  return sorted.map((d) => ({
    vector: d.embedding,
    provider: 'openai' as const,
    model,
    dimensions: d.embedding.length,
  }));
}

// --- Ollama ---

async function embedOllama(
  text: string,
  config: EmbeddingConfig
): Promise<EmbeddingResult> {
  const url = config.ollamaUrl ?? DEFAULTS.ollamaUrl;
  const model = config.ollamaModel ?? DEFAULTS.ollamaModel;

  const response = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embeddings failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    embeddings: number[][];
  };

  return {
    vector: data.embeddings[0],
    provider: 'ollama',
    model,
    dimensions: data.embeddings[0].length,
  };
}
