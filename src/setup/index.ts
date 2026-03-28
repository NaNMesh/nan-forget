#!/usr/bin/env node
/**
 * NaN Forget Setup Wizard
 *
 * One command does everything:
 * 1. Starts Qdrant (docker compose up -d)
 * 2. Installs Ollama + embedding model if needed
 * 3. Asks for project context
 * 4. Saves initial memories
 * 5. Creates MEMORY.md
 * 6. Writes MCP config for Claude Code
 * 7. Copies .env from .env.example
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { execSync } from 'node:child_process';
import { createQdrantClient, ensureCollection } from '../qdrant.js';
import { createEmbedder } from '../embeddings.js';
import { writeMemory } from '../writer.js';
import {
  read as readMemoryMd,
  write as writeMemoryMd,
  addLine,
} from '../memory-md.js';
import type { MemoryType } from '../types.js';

// --- Helpers ---

function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    return new Promise((resolve) => {
      rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  }

  function close() { rl.close(); }
  return { ask, close };
}

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: output.trim() };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Checks ---

async function checkUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch { return false; }
}

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(model));
  } catch { return false; }
}

// --- Auto-installers ---

async function ensureDocker(): Promise<boolean> {
  const { ok } = run('docker --version');
  if (!ok) {
    console.log('  ✗ Docker not found. Install Docker Desktop: https://docker.com/products/docker-desktop');
    return false;
  }
  console.log('  ✓ Docker found');
  return true;
}

async function ensureQdrant(url: string): Promise<boolean> {
  if (await checkUrl(`${url}/healthz`)) {
    console.log('  ✓ Qdrant running');
    return true;
  }

  console.log('  Starting Qdrant...');
  const { ok } = run('docker compose up -d');
  if (!ok) {
    console.log('  ✗ Failed to start Qdrant. Run manually: docker compose up -d');
    return false;
  }

  // Wait for Qdrant to be ready
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (await checkUrl(`${url}/healthz`)) {
      console.log('  ✓ Qdrant started');
      return true;
    }
  }
  console.log('  ✗ Qdrant did not start within 15s. Check: docker compose logs');
  return false;
}

async function ensureOllama(): Promise<boolean> {
  // Already running?
  if (await checkUrl('http://localhost:11434/')) {
    console.log('  ✓ Ollama running');
    return true;
  }

  // Installed but not running?
  const { ok: installed } = run('which ollama');
  const macApp = run('ls /Applications/Ollama.app').ok;

  if (!installed && !macApp) {
    // Try to install
    const os = platform();
    if (os === 'darwin') {
      console.log('  Installing Ollama via Homebrew...');
      const { ok } = run('brew install ollama');
      if (!ok) {
        console.log('  ✗ Could not install Ollama. Install manually: https://ollama.com');
        return false;
      }
      console.log('  ✓ Ollama installed');
    } else if (os === 'linux') {
      console.log('  Installing Ollama...');
      const { ok } = run('curl -fsSL https://ollama.com/install.sh | sh');
      if (!ok) {
        console.log('  ✗ Could not install Ollama. Install manually: https://ollama.com');
        return false;
      }
      console.log('  ✓ Ollama installed');
    } else {
      console.log('  ✗ Ollama not found. Install from: https://ollama.com');
      return false;
    }
  }

  // Start Ollama
  console.log('  Starting Ollama...');
  if (platform() === 'darwin') {
    run('brew services start ollama');
  } else {
    // Start in background
    run('ollama serve &');
  }

  // Wait for it
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (await checkUrl('http://localhost:11434/')) {
      console.log('  ✓ Ollama started');
      return true;
    }
  }

  console.log('  ✗ Ollama did not start. Try: ollama serve');
  return false;
}

async function ensureEmbeddingModel(): Promise<boolean> {
  const model = 'nomic-embed-text';

  if (await ollamaHasModel(model)) {
    console.log(`  ✓ ${model} model ready`);
    return true;
  }

  console.log(`  Pulling ${model} (~274 MB)...`);
  const { ok } = run(`ollama pull ${model}`);
  if (!ok) {
    console.log(`  ✗ Failed to pull ${model}. Run manually: ollama pull ${model}`);
    return false;
  }

  console.log(`  ✓ ${model} pulled`);
  return true;
}

// --- MCP Config ---

interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

async function writeMcpConfig(_provider: string, _openaiKey: string): Promise<string> {
  // Register MCP server via `claude mcp add` (works for Claude Code)
  const { ok: hasClaude } = run('which claude');

  if (hasClaude) {
    // Remove old entry first (ignore errors if not exists)
    run('claude mcp remove nan-forget 2>/dev/null');
    const { ok } = run('claude mcp add nan-forget -- npx nan-forget serve');
    if (ok) {
      return 'Claude Code MCP (via claude mcp add)';
    }
  }

  // Fallback: write directly to ~/.claude.json
  const claudeJsonPath = join(homedir(), '.claude.json');
  try {
    let config: Record<string, unknown> = {};
    try {
      const raw = await readFile(claudeJsonPath, 'utf-8');
      config = JSON.parse(raw);
    } catch { /* new file */ }

    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    // Add to global mcpServers
    if (!config.mcpServers) config.mcpServers = {};
    (config.mcpServers as Record<string, unknown>)['nan-forget'] = {
      type: 'stdio',
      command: 'npx',
      args: ['nan-forget', 'serve'],
      env: {},
    };

    // Also write Claude Desktop config for GUI users
    const claudeConfigDir = join(homedir(), '.claude');
    const desktopConfigPath = join(claudeConfigDir, 'claude_desktop_config.json');
    await mkdir(claudeConfigDir, { recursive: true });

    let desktopConfig: McpConfig = { mcpServers: {} };
    try {
      await access(desktopConfigPath);
      const raw = await readFile(desktopConfigPath, 'utf-8');
      desktopConfig = JSON.parse(raw);
      if (!desktopConfig.mcpServers) desktopConfig.mcpServers = {};
    } catch { /* new file */ }

    desktopConfig.mcpServers['nan-forget'] = {
      command: 'npx',
      args: ['nan-forget', 'serve'],
      env: {},
    };
    await writeFile(desktopConfigPath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

    return claudeJsonPath;
  } catch {
    return 'Failed to write MCP config';
  }
}

// --- .env ---

async function ensureDotEnv(provider: string, openaiKey: string): Promise<void> {
  const envPath = join(process.cwd(), '.env');
  try {
    await access(envPath);
    // .env already exists, don't overwrite
    return;
  } catch {
    // Create from example
  }

  const lines = [
    `NAN_FORGET_EMBEDDING_PROVIDER=${provider}`,
    `NAN_FORGET_USER_ID=default`,
    `NAN_FORGET_QDRANT_URL=http://localhost:6333`,
  ];
  if (openaiKey) lines.push(`OPENAI_API_KEY=${openaiKey}`);

  await writeFile(envPath, lines.join('\n') + '\n', 'utf-8');
}

// --- Hooks + CLAUDE.md ---

async function installHooksAndClaudeMd(): Promise<void> {
  const projectDir = process.cwd();
  const claudeDir = join(projectDir, '.claude');
  const hooksDir = join(claudeDir, 'hooks');

  await mkdir(hooksDir, { recursive: true });

  // Write Node.js hook
  const hookContent = `#!/usr/bin/env node
import { readFileSync } from 'fs';
import { execFile } from 'child_process';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data?.tool_input?.file_path ?? '';
    if (!filePath || !filePath.includes('/memory/') || !filePath.endsWith('.md')) process.exit(0);
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { process.exit(0); }
    const parts = content.split('---');
    if (parts.length < 3) process.exit(0);
    const frontmatter = parts[1];
    const body = parts.slice(2).join('---').trim();
    if (!body) process.exit(0);
    const typeMatch = frontmatter.match(/^type:\\s*(.+)$/m);
    const rawType = typeMatch?.[1]?.trim() ?? 'fact';
    const typeMap = { user: 'fact', feedback: 'preference', project: 'context', reference: 'fact' };
    const nfType = typeMap[rawType] ?? 'fact';
    let project = '_global';
    const projectMatch = filePath.match(/\\/projects\\/([^/]+)\\//);
    if (projectMatch) { const s = projectMatch[1].split('-'); project = s[s.length - 1] || '_global'; }
    execFile('npx', ['nan-forget', 'add', body.slice(0, 2000), '--type', nfType, '--project', project, '--tags', 'auto-sync,claude-memory'], { timeout: 15000 }, () => {});
  } catch {}
  process.exit(0);
});
`;

  await writeFile(join(hooksDir, 'memory-sync.js'), hookContent, 'utf-8');
  run(`chmod +x "${join(hooksDir, 'memory-sync.js')}"`);

  // Write session-end hook (saves unsaved context when session closes)
  const sessionEndContent = `#!/usr/bin/env node
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
const PATTERNS = [
  { pattern: /\\b(decided|chose|switched to|went with|using .+ instead of)\\b/i, type: 'decision' },
  { pattern: /\\b(prefer|always use|never use|convention is)\\b/i, type: 'preference' },
  { pattern: /\\b(tech stack|framework|database|deploy|hosting|endpoint)\\b/i, type: 'fact' },
  { pattern: /\\b(TODO|need to|should|must|next step|blocked)\\b/i, type: 'task' },
  { pattern: /\\b(working on|currently|in progress|building|implementing)\\b/i, type: 'context' },
];
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tp = data?.transcript_path;
    if (!tp) process.exit(0);
    let lines;
    try { lines = readFileSync(tp, 'utf-8').split('\\n').filter(Boolean).map(l => JSON.parse(l)); } catch { process.exit(0); }
    const msgs = lines.filter(l => l.role === 'assistant' && typeof l.content === 'string').slice(-20);
    const project = (data?.cwd ?? '').split('/').pop() || '_global';
    const toSave = []; const seen = new Set();
    for (const msg of msgs) {
      const sentences = (msg.content || '').split(/[.!?\\n]/).filter(s => s.trim().length > 15 && s.trim().length < 500);
      for (const s of sentences) {
        const t = s.trim();
        for (const { pattern, type } of PATTERNS) {
          if (pattern.test(t) && !seen.has(t.slice(0, 50))) { seen.add(t.slice(0, 50)); toSave.push({ content: t, type }); break; }
        }
      }
    }
    for (const item of toSave.slice(-5)) {
      try { execFileSync('npx', ['nan-forget', 'add', item.content, '--type', item.type, '--project', project, '--tags', 'auto-save,session-end'], { timeout: 10000, stdio: 'ignore' }); } catch {}
    }
  } catch {}
  process.exit(0);
});
`;

  await writeFile(join(hooksDir, 'session-end.js'), sessionEndContent, 'utf-8');
  run(`chmod +x "${join(hooksDir, 'session-end.js')}"`);

  // Write settings.json with hook config
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = {
    hooks: {
      PostToolUse: [{
        matcher: 'Write|Edit',
        hooks: [{
          type: 'command',
          command: `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/memory-sync.js`,
          timeout: 10,
        }],
      }],
      SessionEnd: [{
        hooks: [{
          type: 'command',
          command: `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-end.js`,
          timeout: 30,
        }],
      }],
    },
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  // Copy CLAUDE.md to project root if not exists
  const claudeMdDest = join(projectDir, 'CLAUDE.md');
  const claudeMdSrc = join(resolve(__dirname, '..', '..'), 'CLAUDE.md');
  try {
    await access(claudeMdDest);
    // Already exists, don't overwrite
  } catch {
    try {
      await copyFile(claudeMdSrc, claudeMdDest);
    } catch {
      // Source doesn't exist (installed via npm), write inline
      const claudeMd = `# NaN Forget — AI Long-Term Memory (MANDATORY)

## Rules (Non-Negotiable)

1. **At session start**: Call \`memory_sync\` ONCE. Lightweight handshake — checks services and tells you how many memories exist. It does NOT search.
2. **During the session — SEARCH**: Whenever you encounter a topic that may have prior context, call \`memory_search\` IMMEDIATELY. Do NOT wait for the user to ask.
3. **During the session — SAVE**: Call \`memory_save\` immediately whenever you learn a decision, preference, fact, or context. Do NOT wait. Do NOT batch. Save as you go.
4. **If services are down**: \`memory_sync\` will tell you. Ask the user, then call \`memory_start\`.

## How to Think About It

- \`memory_sync\` = "wake up, check if brain is working"
- \`memory_search\` = "do I remember anything about this topic?" (call often, during conversation)
- \`memory_save\` = "I should remember this for next time" (call immediately when you learn something)

## What to Save

- Architecture decisions, user preferences, project facts, context, tasks
- Rule: if it would be useful in a future session, save it NOW.

## Context Management

Fully automatic. Consolidation and cleanup run after every 10 saves or 24h.
`;
      await writeFile(claudeMdDest, claudeMd, 'utf-8');
    }
  }
}

// --- Main ---

export async function setup(): Promise<void> {
  const prompt = createPrompt();
  const qdrantUrl = 'http://localhost:6333';

  console.log('\n🧠 NaN Forget — Setup\n');
  console.log('Checking dependencies...\n');

  // ── Step 1: Docker + Qdrant ──
  const hasDocker = await ensureDocker();
  if (!hasDocker) { prompt.close(); return; }

  const hasQdrant = await ensureQdrant(qdrantUrl);
  if (!hasQdrant) { prompt.close(); return; }

  // ── Step 2: Embeddings ──
  // Try Ollama first (free). Fall back to OpenAI key.
  let provider = 'ollama';
  let openaiKey = '';

  const hasOllama = await ensureOllama();

  if (hasOllama) {
    const hasModel = await ensureEmbeddingModel();
    if (!hasModel) { prompt.close(); return; }
  } else {
    // Ollama failed, try OpenAI
    openaiKey = process.env.OPENAI_API_KEY ?? '';
    if (!openaiKey) {
      openaiKey = await prompt.ask('\nNo Ollama available. Enter OpenAI API key (or leave blank to abort)');
      if (!openaiKey) {
        console.log('\n  Setup needs either Ollama or an OpenAI key for embeddings.');
        console.log('  Install Ollama: https://ollama.com\n');
        prompt.close();
        return;
      }
    }
    provider = 'openai';
    console.log('  ✓ Using OpenAI embeddings');
  }

  console.log('\n  All dependencies ready.\n');

  // ── Step 3: Project context ──
  console.log('Tell me about your project (press Enter to skip any):\n');

  const projectName = await prompt.ask('Project name');
  const stack = await prompt.ask('Tech stack (e.g. "Next.js, PostgreSQL, Prisma")');
  const deployment = await prompt.ask('Deploy target (e.g. "Vercel", "Railway")');
  const preferences = await prompt.ask('Coding style (e.g. "strict TypeScript, no-any")');

  // ── Step 4: Save memories ──
  console.log('\n  Saving initial memories...');

  const client = createQdrantClient(qdrantUrl);
  const embedder = createEmbedder({
    provider: provider as 'openai' | 'ollama',
    openaiApiKey: openaiKey,
  });

  await ensureCollection(client, embedder.provider);

  const memories: { content: string; type: MemoryType; tags: string[] }[] = [];
  if (stack) memories.push({ content: `Tech stack: ${stack}`, type: 'fact', tags: ['stack', 'setup'] });
  if (deployment) memories.push({ content: `Deployment: ${deployment}`, type: 'decision', tags: ['deploy', 'setup'] });
  if (preferences) memories.push({ content: preferences, type: 'preference', tags: ['coding-style', 'setup'] });

  let memState = await readMemoryMd();
  const userId = 'default';

  for (const m of memories) {
    const result = await writeMemory(client, embedder, {
      content: m.content,
      type: m.type,
      project: projectName || '_global',
      tags: m.tags,
      user_id: userId,
    });

    const mem = await (await import('../qdrant.js')).getMemory(client, result.id);
    if (mem) {
      memState = addLine(memState, {
        type: mem.type,
        summary: mem.summary,
        engram_id: mem.id,
        project: mem.project,
      });
    }
    console.log(`  ✓ ${m.content.slice(0, 60)}`);
  }

  if (memories.length > 0) {
    await writeMemoryMd(memState);
    console.log(`  ✓ MEMORY.md created (${memState.lines.length} entries)`);
  }

  // ── Step 5: Docker restart policy ──
  run('docker update --restart=always nan-forget-qdrant');
  console.log('  ✓ Qdrant set to auto-start on reboot');

  // ── Step 6: Write configs ──
  const configPath = await writeMcpConfig(provider, openaiKey);
  console.log(`  ✓ MCP config → ${configPath}`);

  await ensureDotEnv(provider, openaiKey);
  console.log('  ✓ .env created');

  // ── Step 7: Install Claude Code hooks + CLAUDE.md ──
  await installHooksAndClaudeMd();
  console.log('  ✓ Claude Code hooks installed');
  console.log('  ✓ CLAUDE.md created');

  // ── Step 8: Install global slash command ──
  const globalCommandsDir = join(homedir(), '.claude', 'commands');
  await mkdir(globalCommandsDir, { recursive: true });
  const slashCommandSrc = join(resolve(__dirname, '..', '..'), '.claude', 'commands', 'nan-forget.md');
  const slashCommandDest = join(globalCommandsDir, 'nan-forget.md');
  try {
    await copyFile(slashCommandSrc, slashCommandDest);
    console.log('  ✓ /nan-forget slash command installed globally');
  } catch {
    // Source doesn't exist (npm install), write inline
    const slashContent = `# nan-forget — Memory Management

Manual control for your AI long-term memory. Run without arguments to sync context, or with a subcommand.

## Usage

- \`/nan-forget\` — Load context from past sessions (calls memory_sync)
- \`/nan-forget clean\` — Run garbage collection on stale memories
- \`/nan-forget stats\` — Show memory health
- \`/nan-forget compact\` — Force consolidation of aging memories
- \`/nan-forget health\` — Check if services are running
- \`/nan-forget start\` — Start all services

## Instructions

Parse the subcommand from \`$ARGUMENTS\`. If empty or "sync", call \`memory_sync\`. Otherwise:

- \`$ARGUMENTS\` = "clean" → call \`memory_clean\` tool, show results
- \`$ARGUMENTS\` = "stats" → call \`memory_stats\` tool, show results
- \`$ARGUMENTS\` = "compact" → call \`memory_consolidate\` tool, show results
- \`$ARGUMENTS\` = "health" → call \`memory_health\` tool, show results
- \`$ARGUMENTS\` = "start" → call \`memory_start\` tool, show results

Always display the tool results directly to the user in a clean, readable format.
`;
    await writeFile(slashCommandDest, slashContent, 'utf-8');
    console.log('  ✓ /nan-forget slash command installed globally');
  }

  // ── Step 9: Start REST API for non-MCP LLMs ──
  const startApi = await prompt.ask('\nStart REST API for Codex/Cursor? (y/n)', 'y');
  if (startApi.toLowerCase() === 'y') {
    const { ok: apiOk } = run('npx nan-forget api &');
    if (apiOk) {
      console.log('  ✓ REST API running on http://localhost:3456');
      console.log('    Get system prompt: nan-forget prompt');
    }
  }

  // ── Done ──
  console.log('\n🎉 Done. Restart Claude Code. That\'s it.\n');
  console.log('nan-forget will automatically:');
  console.log('  • Load context from past sessions on startup');
  console.log('  • Save decisions, preferences, and facts as you work');
  console.log('  • Consolidate and clean memories in the background');
  console.log('  • Share memories across all AI tools (Claude, Codex, etc.)\n');

  if (memories.length > 0) {
    console.log('Try it:');
    console.log(`  nan-forget search "what stack are we using?"`);
    console.log(`  nan-forget stats\n`);
  } else {
    console.log('Save your first memory:');
    console.log(`  nan-forget add "We use Next.js with Prisma"\n`);
  }

  prompt.close();
}

// Auto-run
const isMain = process.argv[1]?.includes('setup');
if (isMain) {
  setup().catch((err) => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
}
