# nan-forget — Memory Management

Manual control for your AI long-term memory. Run without arguments to sync context, or with a subcommand.

## Usage

- `/nan-forget` — Show memory stats and health
- `/nan-forget setup` — Run full setup (Qdrant, Ollama, hooks, MCP)
- `/nan-forget clean` — Run garbage collection on stale memories
- `/nan-forget stats` — Show memory health (active, archived, by type/project)
- `/nan-forget compact` — Force consolidation of aging memories
- `/nan-forget health` — Check if Qdrant, Ollama, and REST API are running
- `/nan-forget start` — Start all services
- `/nan-forget search <query>` — Search memories

## Instructions

Parse the subcommand from `$ARGUMENTS`. Try the MCP tool first, fall back to CLI.

**Default (no arguments):** Try `memory_sync` MCP tool. If not available, run `npx nan-forget stats` via Bash.

**Subcommands:**

- `setup` → run `npx nan-forget setup` via Bash (interactive — let user respond to prompts)
- `clean` → try `memory_clean` tool, else run `npx nan-forget clean` via Bash
- `stats` → try `memory_stats` tool, else run `npx nan-forget stats` via Bash
- `compact` → try `memory_consolidate` tool, else run `npx nan-forget consolidate` via Bash
- `health` → try `memory_health` tool, else run `npx nan-forget health` via Bash
- `start` → try `memory_start` tool, else run `npx nan-forget start` via Bash
- `search <query>` → try `memory_search` tool, else run `npx nan-forget search "<query>"` via Bash

**Important:** If MCP tools (`memory_*`) are not available, always fall back to CLI commands. Never tell the user the command is broken — just use the CLI.

For any unrecognized subcommand, show the usage list above.

Always display results in a clean, readable format.
