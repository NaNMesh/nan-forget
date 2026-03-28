/**
 * Service management — shared helpers for checking and starting dependencies.
 *
 * Used by: setup wizard, MCP memory_health/memory_start tools, CLI start command.
 */

import { execSync, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';

// --- Helpers ---

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

export async function checkUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch { return false; }
}

// --- Health Checks ---

export interface HealthStatus {
  qdrant: boolean;
  ollama: boolean;
  api: boolean;
}

export async function checkHealth(
  qdrantUrl = 'http://localhost:6333',
  apiPort = 3456
): Promise<HealthStatus> {
  const [qdrant, ollama, api] = await Promise.all([
    checkUrl(`${qdrantUrl}/healthz`),
    checkUrl('http://localhost:11434/'),
    checkUrl(`http://localhost:${apiPort}/memories/stats`),
  ]);
  return { qdrant, ollama, api };
}

// --- Service Starters ---

export interface StartResult {
  qdrant: { started: boolean; error?: string };
  ollama: { started: boolean; error?: string };
  api: { started: boolean; error?: string };
}

export async function startQdrant(qdrantUrl = 'http://localhost:6333'): Promise<{ started: boolean; error?: string }> {
  if (await checkUrl(`${qdrantUrl}/healthz`)) {
    return { started: true };
  }

  // Check Docker
  const { ok: hasDocker } = run('docker --version');
  if (!hasDocker) {
    return { started: false, error: 'Docker not installed. Install from https://docker.com' };
  }

  // Try docker compose up
  const { ok } = run('docker compose up -d');
  if (!ok) {
    // Try starting existing container
    const { ok: restarted } = run('docker start nan-forget-qdrant');
    if (!restarted) {
      return { started: false, error: 'Failed to start Qdrant. Run: docker compose up -d' };
    }
  }

  // Wait for ready
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (await checkUrl(`${qdrantUrl}/healthz`)) {
      return { started: true };
    }
  }
  return { started: false, error: 'Qdrant did not become healthy within 15s' };
}

export async function startOllama(): Promise<{ started: boolean; error?: string }> {
  if (await checkUrl('http://localhost:11434/')) {
    return { started: true };
  }

  const { ok: installed } = run('which ollama');
  const macApp = run('ls /Applications/Ollama.app').ok;

  if (!installed && !macApp) {
    if (platform() === 'darwin') {
      const { ok } = run('brew install ollama');
      if (!ok) return { started: false, error: 'Could not install Ollama. Install from https://ollama.com' };
    } else if (platform() === 'linux') {
      const { ok } = run('curl -fsSL https://ollama.com/install.sh | sh');
      if (!ok) return { started: false, error: 'Could not install Ollama. Install from https://ollama.com' };
    } else {
      return { started: false, error: 'Ollama not found. Install from https://ollama.com' };
    }
  }

  // Start
  if (platform() === 'darwin') {
    run('open -a Ollama || brew services start ollama');
  } else {
    run('ollama serve &');
  }

  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (await checkUrl('http://localhost:11434/')) {
      return { started: true };
    }
  }
  return { started: false, error: 'Ollama did not start. Try: ollama serve' };
}

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(model));
  } catch { return false; }
}

export async function ensureEmbeddingModel(model = 'nomic-embed-text'): Promise<{ ready: boolean; error?: string }> {
  if (await ollamaHasModel(model)) return { ready: true };

  const { ok } = run(`ollama pull ${model}`);
  if (!ok) return { ready: false, error: `Failed to pull ${model}. Run: ollama pull ${model}` };
  return { ready: true };
}

export async function startApi(port = 3456): Promise<{ started: boolean; error?: string }> {
  if (await checkUrl(`http://localhost:${port}/memories/stats`)) {
    return { started: true };
  }

  // Spawn detached process
  const child = spawn('npx', ['nan-forget', 'api'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NAN_FORGET_API_PORT: String(port) },
  });
  child.unref();

  // Wait for ready
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (await checkUrl(`http://localhost:${port}/memories/stats`)) {
      return { started: true };
    }
  }
  return { started: false, error: `REST API did not start on port ${port}` };
}

export async function startAll(qdrantUrl = 'http://localhost:6333', apiPort = 3456): Promise<StartResult> {
  const qdrant = await startQdrant(qdrantUrl);

  let ollama: { started: boolean; error?: string } = { started: false };
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    ollama = await startOllama();
    if (ollama.started) {
      await ensureEmbeddingModel();
    }
  } else {
    ollama = { started: true }; // Not needed with OpenAI
  }

  const api = await startApi(apiPort);

  return { qdrant, ollama, api };
}
