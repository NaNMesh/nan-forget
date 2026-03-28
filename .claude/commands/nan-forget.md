# nan-forget — Memory Management

Manual control for your AI long-term memory. Run without arguments to sync context, or with a subcommand.

## Usage

- `/nan-forget` — Load context from past sessions (calls memory_sync)
- `/nan-forget clean` — Run garbage collection on stale memories
- `/nan-forget stats` — Show memory health (active, archived, by type/project)
- `/nan-forget compact` — Force consolidation of aging memories into long-term entries
- `/nan-forget health` — Check if Qdrant, Ollama, and REST API are running
- `/nan-forget start` — Start all services (asks permission first)

## Instructions

Parse the subcommand from `$ARGUMENTS`. If empty or "sync", call `memory_sync`. Otherwise:

- `$ARGUMENTS` = "clean" → call `memory_clean` tool, show results
- `$ARGUMENTS` = "stats" → call `memory_stats` tool, show results
- `$ARGUMENTS` = "compact" → call `memory_consolidate` tool, show results
- `$ARGUMENTS` = "health" → call `memory_health` tool, show results
- `$ARGUMENTS` = "start" → call `memory_start` tool, show results

For any unrecognized subcommand, show the usage list above.

Always display the tool results directly to the user in a clean, readable format.
