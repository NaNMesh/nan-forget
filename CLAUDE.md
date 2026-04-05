# NaN Forget — AI Long-Term Memory (MANDATORY)

## Rules (Non-Negotiable)

1. **At session start**: Call `memory_sync` ONCE. This is a lightweight handshake — it checks services and tells you how many memories exist. It does NOT search.
2. **During the session — SEARCH**: Whenever you encounter a topic that may have prior context (auth, deployment, testing, architecture, tooling, etc.), call `memory_search` IMMEDIATELY. Do NOT wait for the user to ask. This is your long-term recall — use it like your own memory. Searches across ALL projects automatically.
3. **During the session — SAVE**: Call `memory_save` immediately whenever you learn a decision, preference, fact, or context. Do NOT wait. Do NOT batch. Save as you go. **Use structured fields** (problem, solution, concepts, files) when possible.
4. **If services are down**: `memory_sync` will tell you. Ask the user, then call `memory_start`.

## How to Think About It

- `memory_sync` = "wake up, check if brain is working"
- `memory_search` = "do I remember anything about this topic?" (call often, during conversation)
- `memory_save` = "I should remember this for next time" (call immediately when you learn something)

The user should never need to tell you to search or save. You do it automatically, like a human would.

## Memory Architecture

- **Long-term memory** = nan-forget SQLite DB (`~/.nan-forget/memories.db`). Source of truth. Persists forever, searchable, auto-consolidates.
- **Short-term memory** = Claude's `.md` files. Disposable scratch paper for current session only. Keep these MINIMAL.
- The DB always wins over `.md` files.

## How to Save (Structured Memories)

When saving, use structured fields to capture the FULL context:

```
memory_save({
  content: "Full description of what happened and why",
  type: "decision",
  project: "my-project",
  problem: "What was the problem or challenge we faced",
  solution: "How we solved it — the approach and key implementation details",
  concepts: ["auth", "jwt", "middleware"],
  files: ["src/auth.ts", "src/middleware.ts"],
  tags: ["security", "api"],
  provenance: "save",       // or "checkpoint", "debate", "human"
  confidence: 0.5           // auto-set from provenance if omitted
})
```

### Memory Tiers

Memories have a **confidence** (0.0–1.0) and **tier** (regular/core). High-confidence memories decay slower and rank higher.

| Provenance | Default Confidence | Tier |
|-----------|-------------------|------|
| `save` | 0.5 | regular |
| `checkpoint` | 0.65 | regular |
| `debate` | 0.85 | **core** |
| `human` | 0.95 | **core** |

Use `provenance: "debate"` for multi-AI debate results. Use `provenance: "human"` for user-confirmed facts. Core memories survive garbage collection ~6x longer than regular ones.

### What to Save
- **Decisions**: "We chose X over Y because Z" → include problem (why we needed to choose) and solution (what we picked and why)
- **Problem-solutions**: Bugs fixed, errors resolved → include the error, root cause, and fix
- **Architecture**: System design, data flow → include files and concepts
- **User preferences**: Coding style, tool choices → include examples
- **Project facts**: Tech stack, deployment, APIs → include relevant files
- **Tasks**: Outstanding work, next steps → include context and blockers

Rule: if it would be useful in a future session, save it NOW. Include problem + solution whenever applicable.

## After Task Completion

When you finish a significant task (bug fix, feature, refactor, config change), call `memory_checkpoint` BEFORE telling the user you're done:

```
memory_checkpoint({
  task_summary: "Fixed JWT token expiration causing 401 errors",
  problem: "Tokens expired after 1 hour but refresh wasn't triggered automatically",
  solution: "Added token refresh interceptor in src/auth.ts that checks expiry 5 min before deadline",
  files: ["src/auth.ts", "src/middleware.ts"],
  concepts: ["auth", "jwt", "token-refresh", "interceptor"],
  project: "my-api"
})
```

This saves the FULL problem→solution context to long-term memory. Next time a similar issue comes up (in any project), `memory_search` will find it.

Every completed task = one checkpoint. This is how nan-forget learns from your work.

## 3-Stage Search (Progressive Disclosure)

nan-forget uses a 3-stage retrieval to minimize token usage:

1. **Stage 1 — Recognition (blur)**: Returns only summaries, scored by vector similarity × decay × frequency. ~50 tokens per memory. Used by hooks automatically.
2. **Stage 2 — Recall (clarity)**: Fetches full content including problem/solution. Only for relevant results.
3. **Stage 3 — Association (spreading activation)**: Finds related memories you didn't search for.

Use `depth: 1` for quick checks, `depth: 2` (default) for working context, `depth: 3` when you need the full picture.

## What to Search

- When you encounter ANY topic that might have prior context
- Before making architecture or tooling decisions
- When the user mentions something from a previous session
- When a topic like "auth", "deploy", "testing" comes up — always check

## Context Management

Fully automatic. Never run clean or consolidate manually.
- After every 10 saves or 24h: aging memories clustered, summarized, compacted
- Decayed/expired/duplicate memories archived automatically
- MEMORY.md kept to max 15 lines — only highest-relevance items

## Tools

| Tool | When |
|------|------|
| `memory_sync` | Once at session start (handshake only) |
| `memory_search` | Dynamically, whenever a topic may have prior context |
| `memory_save` | Immediately when you learn something — use structured fields |
| `memory_get` | When you have a specific memory ID |
| `memory_update` | To correct or refine a memory |
| `memory_archive` | When info is outdated or reversed |
| `memory_health` | Check service status |
| `memory_start` | Start services after user confirms |
| `memory_checkpoint` | BEFORE telling user a task is done — saves problem/solution/files/concepts |
| `memory_compress` | When context feels bloated — compresses persisted .md files to stubs |
| `memory_stats` | Check memory health metrics |
