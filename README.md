# NaN Forget

**Never forget. Long-term memory for any LLM.**

Every session starts from zero. You re-explain your stack. Claude contradicts a decision you made three months ago. Knowledge disappears when the session ends.

NaN Forget gives your LLM an **engram** — a permanent memory trace that survives forever, across every session, any model.

---

## How it works

```
NaN Forget
│
├── Short Memory  → MEMORY.md      always loaded, max 30 lines
└── Engram        → Qdrant local   long-term vectors, semantic search
```

Before every response, your LLM searches the Engram for relevant memories.
After every session, the cleaner maintains MEMORY.md automatically.
Nothing is ever deleted — only archived.

---

## Setup

```bash
git clone https://github.com/NaNMesh/nan-forget
cd nan-forget
docker compose up -d
npm install
npm run setup
npm run install-mcp
```

Restart Claude Code. Done. Under 5 minutes.

No Docker? Use `npm run setup -- --no-docker` for SQLite fallback.

---

## Quick start

```bash
nan-forget add "We use FastAPI not Django — Railway deploys faster"
nan-forget add --type decision "Auth is Clerk, not custom JWT"
nan-forget add --type preference "TypeScript always, never plain JS"

nan-forget search "what auth system are we using"
nan-forget list --pinned
```

---

## MCP tools

Five tools exposed to Claude and any MCP-compatible LLM:

- `memory_save` — save a memory with type, project, tags
- `memory_search` — semantic search with optional filters
- `memory_get` — retrieve a specific memory by ID
- `memory_archive` — archive a memory (never deletes)
- `memory_relate` — link two memories (v2)

---

## Example: NaN Mesh project memory

Here is what a real MEMORY.md looks like after a few sessions on the
[NaN Mesh](https://nanmesh.ai) project — a trust network for AI agents:

```
# NaN Forget — Active Memory
Last cleaned: 2026-03-27

## Pinned Facts
- [fact] NaN Mesh is a trust network at nanmesh.ai — agents vote on products (id: a1)
- [decision] FastAPI over Django — Railway cold start is faster (id: a2)
- [decision] Clerk for auth, not Supabase Auth — webhook syncs to users table (id: a3)
- [preference] Claude-first strategy — OpenAI kept for internal ops only (id: a4)
- [fact] MCP server at api.nanmesh.ai/mcp — 30 tools, nanmesh_ prefix (id: a5)
- [decision] Binary voting +1/-1, one vote per agent per entity (id: a6)

## Current Session Context
- Working on: trust graph dashboard
- Active project: nan-mesh
- Last session: finished Sigma.js force-directed layout
```

Claude reads this at the start of every session. No re-explaining.
No contradictions. No lost context.

---

## Embeddings

| Provider | Model | Cost |
|---|---|---|
| OpenAI (default) | text-embedding-3-small | Your API key |
| Ollama (offline) | nomic-embed-text | Free |

---

## Why not Mem0?

Mem0 is great for app developers embedding memory into products they build.
NaN Forget is for you — the developer — so your LLM remembers your projects.

|  | Mem0 | NaN Forget |
|---|---|---|
| Local first | No | Yes |
| MCP native | No | Yes |
| Free tier | 10K memory cap | Unlimited, local |
| Open source | Client only | Full core |
| Own your data | No | Yes |
| Target | App developers | Individual LLM users |

---

## Built by NaN Logic LLC

Part of the NaN product family:
- [NaN Mesh](https://nanmesh.ai) — trust network for AI agents
- **NaN Forget** — long-term memory for any LLM

MIT License.
