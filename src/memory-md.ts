/**
 * MEMORY.md Manager
 *
 * Short-term working memory — always injected into every session.
 * Max 30 lines. Contains lightweight references to Engram records.
 *
 * Format:
 * ```
 * # NaN Forget — Working Memory
 * <!-- Auto-managed. Do not edit manually. -->
 *
 * ## Project: my-app
 * - [decision] Use FastAPI for backend (engram:abc123)
 * - [preference] Strict TypeScript, no-any (engram:def456)
 *
 * ## Project: other
 * - [fact] Deploys on Railway (engram:ghi789)
 * ```
 */

import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Memory } from './types.js';

// --- Types ---

export interface MemoryLine {
  type: Memory['type'];
  summary: string;
  engram_id: string;
  project: string;
}

export interface MemoryMdState {
  lines: MemoryLine[];
}

// --- Constants ---

const MAX_LINES = 15;
const HEADER = `# NaN Forget — Working Memory
<!-- Auto-managed. Do not edit manually. -->`;

const LINE_REGEX = /^- \[(\w+)\] (.+?) \(engram:([\w-]+)\)$/;

// --- Path Resolution ---

export function resolveMemoryMdPath(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return join(root, 'MEMORY.md');
}

// --- Parse ---

export function parse(content: string): MemoryMdState {
  const lines: MemoryLine[] = [];
  let currentProject = '_global';

  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();

    // Project header
    const projectMatch = trimmed.match(/^## Project:\s*(.+)$/);
    if (projectMatch) {
      currentProject = projectMatch[1].trim();
      continue;
    }

    // Memory line
    const lineMatch = trimmed.match(LINE_REGEX);
    if (lineMatch) {
      lines.push({
        type: lineMatch[1] as Memory['type'],
        summary: lineMatch[2],
        engram_id: lineMatch[3],
        project: currentProject,
      });
    }
  }

  return { lines };
}

// --- Serialize ---

export function serialize(state: MemoryMdState): string {
  const byProject = new Map<string, MemoryLine[]>();

  for (const line of state.lines) {
    const existing = byProject.get(line.project) ?? [];
    existing.push(line);
    byProject.set(line.project, existing);
  }

  const sections: string[] = [HEADER, ''];

  // Sort projects: _global first, then alphabetical
  const projects = [...byProject.keys()].sort((a, b) => {
    if (a === '_global') return -1;
    if (b === '_global') return 1;
    return a.localeCompare(b);
  });

  for (const project of projects) {
    const projectLines = byProject.get(project)!;
    sections.push(`## Project: ${project}`);
    for (const line of projectLines) {
      sections.push(`- [${line.type}] ${line.summary} (engram:${line.engram_id})`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

// --- Read ---

export async function read(projectRoot?: string): Promise<MemoryMdState> {
  const path = resolveMemoryMdPath(projectRoot);
  try {
    await access(path);
    const content = await readFile(path, 'utf-8');
    return parse(content);
  } catch {
    return { lines: [] };
  }
}

// --- Write ---

export async function write(
  state: MemoryMdState,
  projectRoot?: string
): Promise<void> {
  const path = resolveMemoryMdPath(projectRoot);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, serialize(state), 'utf-8');
}

// --- Mutations ---

/** Add a memory line. Evicts oldest if over MAX_LINES. */
export function addLine(state: MemoryMdState, line: MemoryLine): MemoryMdState {
  // Dedup — don't add if engram_id already exists
  if (state.lines.some((l) => l.engram_id === line.engram_id)) {
    return state;
  }

  const next = [...state.lines, line];

  // Evict oldest lines (first in list) if over limit
  if (next.length > MAX_LINES) {
    return { lines: next.slice(next.length - MAX_LINES) };
  }

  return { lines: next };
}

/** Remove a memory line by engram ID. */
export function removeLine(state: MemoryMdState, engramId: string): MemoryMdState {
  return { lines: state.lines.filter((l) => l.engram_id !== engramId) };
}

/** Replace all lines for a project. */
export function replaceProject(
  state: MemoryMdState,
  project: string,
  lines: MemoryLine[]
): MemoryMdState {
  const other = state.lines.filter((l) => l.project !== project);
  const next = [...other, ...lines];
  if (next.length > MAX_LINES) {
    return { lines: next.slice(next.length - MAX_LINES) };
  }
  return { lines: next };
}

/** Sync working memory from a list of top memories (from retriever). */
export function syncFromTopMemories(
  state: MemoryMdState,
  project: string,
  memories: Pick<Memory, 'id' | 'type' | 'summary' | 'project'>[],
  maxPerProject = 10
): MemoryMdState {
  const newLines: MemoryLine[] = memories.slice(0, maxPerProject).map((m) => ({
    type: m.type,
    summary: m.summary,
    engram_id: m.id,
    project: m.project ?? project,
  }));

  return replaceProject(state, project, newLines);
}

/** Get current line count. */
export function lineCount(state: MemoryMdState): number {
  return state.lines.length;
}

/** Check if at capacity. */
export function isFull(state: MemoryMdState): boolean {
  return state.lines.length >= MAX_LINES;
}
