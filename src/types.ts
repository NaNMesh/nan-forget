export type MemoryType = 'fact' | 'decision' | 'preference' | 'task' | 'context';
export type MemoryStatus = 'active' | 'archived';
export type MemorySource = 'agent' | 'user' | 'cleaner';
export type EmbeddingProvider = 'openai' | 'ollama';

export interface Memory {
  id: string;
  user_id: string;
  content: string;
  summary: string;
  type: MemoryType;
  status: MemoryStatus;
  project: string;
  tags: string[];
  source: MemorySource;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  access_count: number;
  last_accessed: string;
  embedding_provider: EmbeddingProvider;
  embedding_model: string;
}

export type MemoryPayload = Omit<Memory, 'id'>;

export interface MemorySearchFilters {
  user_id?: string;
  project?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  tags?: string[];
  embedding_provider?: EmbeddingProvider;
  created_after?: string;
  created_before?: string;
  last_accessed_after?: string;
  last_accessed_before?: string;
  min_access_count?: number;
  max_access_count?: number;
}

export const VECTOR_DIMENSIONS: Record<EmbeddingProvider, number> = {
  openai: 1536,
  ollama: 768,
};

export const COLLECTION_NAME = 'engrams';
