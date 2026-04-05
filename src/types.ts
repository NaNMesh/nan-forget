export type MemoryType = 'fact' | 'decision' | 'preference' | 'task' | 'context';
export type MemoryStatus = 'active' | 'archived';
export type MemorySource = 'agent' | 'user' | 'cleaner';
export type EmbeddingProvider = 'openai' | 'ollama';
export type MemoryTier = 'regular' | 'core';
export type MemoryProvenance = 'save' | 'checkpoint' | 'debate' | 'human';

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
  consolidated_from?: string[];
  /** What was the problem / question / challenge */
  problem?: string;
  /** How was it solved / what was the answer */
  solution?: string;
  /** Files involved in this memory */
  files?: string[];
  /** Searchable concepts (architecture, auth, deploy, etc.) */
  concepts?: string[];
  /** Trust level: 0.0 = guess, 1.0 = proven. Default 0.5 */
  confidence: number;
  /** How this memory was created */
  provenance: MemoryProvenance;
  /** Trust tier: 'regular' or 'core' (debate-validated + human-approved) */
  tier: MemoryTier;
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
  tier?: MemoryTier;
  min_confidence?: number;
}

export const VECTOR_DIMENSIONS: Record<EmbeddingProvider, number> = {
  openai: 1536,
  ollama: 768,
};

export const COLLECTION_NAME = 'engrams';

/** Default confidence scores by provenance */
export const DEFAULT_CONFIDENCE: Record<MemoryProvenance, number> = {
  save: 0.5,
  checkpoint: 0.65,
  debate: 0.85,
  human: 0.95,
};
