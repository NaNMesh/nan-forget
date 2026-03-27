# NaN Forget

**Long-term memory for any LLM.**

You open a new session. You re-explain your stack. Claude contradicts a decision you made three months ago. The session ends and takes your context with it.

NaN Forget stores **engrams**, permanent memory traces that survive across sessions and models.

---

## How it works

```
NaN Forget
│
├── Short Memory  → MEMORY.md      always loaded, max 30 lines
└── Engram        → Qdrant local   long-term vectors, semantic search
```

Your LLM searches the Engram before responding. A cleaner maintains MEMORY.md between sessions. Memories get archived, not deleted.

### Three-stage retrieval

Memory search follows the same path as human recall:

| Stage | What happens |
|---|---|
| **Recognition** (blur) | Fast vector match. Returns summaries only. |
| **Recall** (clarity) | Full content for memories you actually need. |
| **Association** | Related memories surface via Qdrant recommend. |

Unused memories fade on a 30-day half-life. Frequent access keeps them sharp.

```
score = vector_similarity × decay_weight × frequency_boost
decay = 0.5 ^ (days_since_accessed / 30)
```

---

## Setup

```bash
git clone https://github.com/NaNMesh/nan-forget
cd nan-forget
npm install
npm run setup
```

Four commands. The setup wizard handles the rest:

1. Starts Qdrant via Docker (`docker compose up -d`)
2. Installs Ollama if missing (`brew install ollama` on Mac)
3. Pulls the embedding model (`nomic-embed-text`, 274 MB)
4. Asks about your project, saves first memories
5. Writes MCP config for Claude Code
6. Creates `.env` with your settings

Restart Claude Code. Done.

No API keys needed. Ollama runs embeddings locally at zero cost. If you use non-Claude LLMs and prefer OpenAI embeddings, set `OPENAI_API_KEY` in `.env` and the system picks it up. See `.env.example` for all options.

---

## Quick start

```bash
# Save memories
nan-forget add "We use FastAPI not Django, Railway deploys faster"
nan-forget add --type decision --project myapp "Auth is Clerk, not custom JWT"
nan-forget add --type preference "TypeScript always, never plain JS"

# Search memories
nan-forget search "what auth system are we using"
nan-forget search --depth 3 "deployment setup"

# Manage
nan-forget list
nan-forget stats
nan-forget clean            # run GC + sync MEMORY.md
nan-forget archive <id>
nan-forget export > backup.json
```

---

## MCP tools

Five tools for Claude and any MCP-compatible client:

| Tool | Purpose |
|---|---|
| `memory_save` | Store a memory with type, project, tags. Deduplicates automatically. |
| `memory_search` | Three-stage retrieval: blur → clarity → association (depth 1-3) |
| `memory_get` | Fetch a memory by ID |
| `memory_update` | Change content, type, or tags |
| `memory_archive` | Soft-delete (the memory stays in storage, hidden from search) |

Start the MCP server:

```bash
npm run serve
```

The setup wizard writes the Claude Code config for you.

---

## The cleaner

Runs without LLM calls. Zero API cost.

- **Garbage collection** archives memories below the decay threshold (~100 days untouched)
- **Expiration** archives memories past their `expires_at` date
- **Interference resolution** deduplicates near-identical memories, keeps the one with more access
- **MEMORY.md sync** refreshes working memory with top-scored memories per project

```bash
nan-forget clean
```

---

## Real MEMORY.md

A few sessions on the [NaN Mesh](https://nanmesh.ai) project produce this:

```
# NaN Forget — Working Memory
<!-- Auto-managed. Do not edit manually. -->

## Project: nan-mesh
- [fact] NaN Mesh is a trust network at nanmesh.ai (engram:a1b2c3)
- [decision] FastAPI over Django, Railway cold start is faster (engram:d4e5f6)
- [decision] Clerk for auth, not Supabase Auth, webhook syncs to users table (engram:g7h8i9)
- [preference] Claude-first strategy, OpenAI kept for internal ops only (engram:j0k1l2)
- [fact] MCP server at api.nanmesh.ai/mcp, 30 tools, nanmesh_ prefix (engram:m3n4o5)
- [decision] Binary voting +1/-1, one vote per agent per entity (engram:p6q7r8)
```

Claude loads this at session start. You stop repeating yourself.

---

## Embeddings

| Provider | Model | Cost | When to use |
|---|---|---|---|
| Ollama (default) | nomic-embed-text | Free, local | Claude Code, Cursor, any MCP client |
| OpenAI | text-embedding-3-small | Your API key | Non-Claude LLMs, or if you prefer cloud |

Auto-detection: if Ollama is running, NaN Forget uses it. If not, it checks for `OPENAI_API_KEY`. No configuration needed.

---

## Mem0 comparison

Mem0 targets app developers who embed memory into products they build. NaN Forget targets you, the developer using AI tools daily.

|  | Mem0 | NaN Forget |
|---|---|---|
| Target | App developers | Individual developers |
| Runs locally | Cloud-first | Fully local |
| MCP integration | Generic | Claude Code hooks + MCP |
| LLM cost for memory ops | Yes (extraction) | Zero (deterministic cleaner) |
| Setup | Complex self-host | `docker compose up` + `npm run setup` |
| Free tier | 10K memory cap | Unlimited |
| Data ownership | Cloud default | Yours |

---

## Architecture

```
src/
├── qdrant.ts        Qdrant client wrapper + schema
├── embeddings.ts    OpenAI / Ollama abstraction
├── writer.ts        Memory writer with dedup
├── retriever.ts     Three-stage retrieval pipeline
├── memory-md.ts     MEMORY.md manager
├── cleaner.ts       Deterministic cleaner (no LLM)
├── mcp/server.ts    MCP server, 5 tools
├── cli/index.ts     CLI commands
└── setup/index.ts   Setup wizard
```

---

## Built by NaN Logic LLC

- [NaN Mesh](https://nanmesh.ai), trust network for AI agents
- **NaN Forget**, long-term memory for any LLM

MIT License.
