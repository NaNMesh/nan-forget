# NaN Forget — AI Long-Term Memory (MANDATORY)

## Rules (Non-Negotiable)

1. **At session start**: Call `memory_sync` ONCE. This is a lightweight handshake — it checks services and tells you how many memories exist. It does NOT search.
2. **During the session — SEARCH**: Whenever you encounter a topic that may have prior context (auth, deployment, testing, architecture, tooling, etc.), call `memory_search` IMMEDIATELY. Do NOT wait for the user to ask. This is your long-term recall — use it like your own memory. Searches across ALL projects automatically.
3. **During the session — SAVE**: Call `memory_save` immediately whenever you learn a decision, preference, fact, or context. Do NOT wait. Do NOT batch. Save as you go.
4. **If services are down**: `memory_sync` will tell you. Ask the user, then call `memory_start`.

## How to Think About It

- `memory_sync` = "wake up, check if brain is working"
- `memory_search` = "do I remember anything about this topic?" (call often, during conversation)
- `memory_save` = "I should remember this for next time" (call immediately when you learn something)

The user should never need to tell you to search or save. You do it automatically, like a human would.

## Memory Architecture

- **Long-term memory** = nan-forget Qdrant DB. Source of truth. Persists forever, searchable, auto-consolidates.
- **Short-term memory** = Claude's `.md` files. Disposable scratch paper for current session only.
- The DB always wins over `.md` files.

## What to Save

- Architecture decisions: "We chose X over Y because Z"
- User preferences: coding style, tool choices, workflow habits
- Project facts: tech stack, deployment target, team info, APIs used
- Context: what's being worked on, blockers, dependencies
- Tasks: outstanding work, next steps, follow-ups

Rule: if it would be useful in a future session, save it NOW.

## What to Search

- When you encounter ANY topic that might have prior context
- Before making architecture or tooling decisions
- When the user mentions something from a previous session
- When a topic like "auth", "deploy", "testing" comes up — always check

## Context Management

Fully automatic. Never run clean or consolidate manually.
- After every 10 saves or 24h: aging memories clustered, summarized, compacted
- Decayed/expired/duplicate memories archived automatically

## Tools

| Tool | When |
|------|------|
| `memory_sync` | Once at session start (handshake only) |
| `memory_search` | Dynamically, whenever a topic may have prior context |
| `memory_save` | Immediately when you learn something |
| `memory_get` | When you have a specific memory ID |
| `memory_update` | To correct or refine a memory |
| `memory_archive` | When info is outdated or reversed |
| `memory_health` | Check service status |
| `memory_start` | Start services after user confirms |
| `memory_stats` | Check memory health metrics |
