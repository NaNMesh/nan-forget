import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parse,
  serialize,
  read,
  write,
  addLine,
  removeLine,
  replaceProject,
  syncFromTopMemories,
  lineCount,
  isFull,
  type MemoryMdState,
  type MemoryLine,
} from '../memory-md.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'nanforget-md-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const makeLine = (
  type: MemoryLine['type'] = 'decision',
  summary = 'Test memory',
  id = 'abc123',
  project = 'my-app'
): MemoryLine => ({ type, summary, engram_id: id, project });

describe('parse + serialize roundtrip', () => {
  it('roundtrips correctly', () => {
    const state: MemoryMdState = {
      lines: [
        makeLine('decision', 'Use FastAPI for backend', 'id1', 'my-app'),
        makeLine('preference', 'Strict TS no-any', 'id2', 'my-app'),
        makeLine('fact', 'Deploys on Railway', 'id3', 'other'),
      ],
    };

    const serialized = serialize(state);
    const parsed = parse(serialized);
    expect(parsed.lines).toEqual(state.lines);
  });

  it('handles empty state', () => {
    const state: MemoryMdState = { lines: [] };
    const serialized = serialize(state);
    expect(serialized).toContain('# NaN Forget');
    const parsed = parse(serialized);
    expect(parsed.lines).toEqual([]);
  });
});

describe('read + write file operations', () => {
  it('read returns empty state when file missing', async () => {
    const state = await read(tempDir);
    expect(state.lines).toEqual([]);
  });

  it('write creates file, read parses it back', async () => {
    const state: MemoryMdState = {
      lines: [makeLine('fact', 'Node 22 runtime', 'x1', 'proj')],
    };
    await write(state, tempDir);

    const content = await readFile(join(tempDir, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('Node 22 runtime');
    expect(content).toContain('engram:x1');

    const readBack = await read(tempDir);
    expect(readBack.lines).toEqual(state.lines);
  });
});

describe('addLine', () => {
  it('adds a line', () => {
    const state: MemoryMdState = { lines: [] };
    const next = addLine(state, makeLine());
    expect(next.lines.length).toBe(1);
  });

  it('deduplicates by engram_id', () => {
    const state: MemoryMdState = { lines: [makeLine('fact', 'A', 'same-id')] };
    const next = addLine(state, makeLine('decision', 'B', 'same-id'));
    expect(next.lines.length).toBe(1);
  });

  it('evicts oldest when over 30 lines', () => {
    const lines: MemoryLine[] = Array.from({ length: 30 }, (_, i) =>
      makeLine('fact', `Memory ${i}`, `id${i}`, 'p')
    );
    const state: MemoryMdState = { lines };
    const next = addLine(state, makeLine('fact', 'New one', 'new-id', 'p'));
    expect(next.lines.length).toBe(30);
    // First line (id0) should be gone
    expect(next.lines.find((l) => l.engram_id === 'id0')).toBeUndefined();
    // New line should be present
    expect(next.lines.find((l) => l.engram_id === 'new-id')).toBeDefined();
  });
});

describe('removeLine', () => {
  it('removes by engram_id', () => {
    const state: MemoryMdState = {
      lines: [makeLine('fact', 'A', 'id1'), makeLine('fact', 'B', 'id2')],
    };
    const next = removeLine(state, 'id1');
    expect(next.lines.length).toBe(1);
    expect(next.lines[0].engram_id).toBe('id2');
  });

  it('no-op if id not found', () => {
    const state: MemoryMdState = { lines: [makeLine()] };
    const next = removeLine(state, 'nonexistent');
    expect(next.lines.length).toBe(1);
  });
});

describe('replaceProject', () => {
  it('replaces all lines for a project', () => {
    const state: MemoryMdState = {
      lines: [
        makeLine('fact', 'Old A', 'a', 'proj1'),
        makeLine('fact', 'Keep B', 'b', 'proj2'),
      ],
    };
    const next = replaceProject(state, 'proj1', [
      makeLine('decision', 'New C', 'c', 'proj1'),
    ]);
    expect(next.lines.length).toBe(2);
    expect(next.lines.find((l) => l.engram_id === 'a')).toBeUndefined();
    expect(next.lines.find((l) => l.engram_id === 'c')).toBeDefined();
    expect(next.lines.find((l) => l.engram_id === 'b')).toBeDefined();
  });
});

describe('syncFromTopMemories', () => {
  it('replaces project lines with top memories', () => {
    const state: MemoryMdState = {
      lines: [makeLine('fact', 'Old', 'old', 'proj')],
    };
    const memories = [
      { id: 'new1', type: 'decision' as const, summary: 'New decision', project: 'proj' },
      { id: 'new2', type: 'fact' as const, summary: 'New fact', project: 'proj' },
    ];
    const next = syncFromTopMemories(state, 'proj', memories);
    expect(next.lines.length).toBe(2);
    expect(next.lines[0].engram_id).toBe('new1');
  });

  it('caps at maxPerProject', () => {
    const state: MemoryMdState = { lines: [] };
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      type: 'fact' as const,
      summary: `Mem ${i}`,
      project: 'proj',
    }));
    const next = syncFromTopMemories(state, 'proj', memories, 5);
    expect(next.lines.length).toBe(5);
  });
});

describe('helpers', () => {
  it('lineCount returns correct count', () => {
    expect(lineCount({ lines: [makeLine(), makeLine('fact', 'B', 'id2')] })).toBe(2);
  });

  it('isFull returns true at 30', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      makeLine('fact', `M${i}`, `id${i}`)
    );
    expect(isFull({ lines })).toBe(true);
    expect(isFull({ lines: lines.slice(0, 29) })).toBe(false);
  });
});
