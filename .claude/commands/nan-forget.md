# nan-forget — Memory Management

Manual control for your AI long-term memory. Run without arguments to sync context, or with a subcommand.

## Usage

- `/nan-forget` — Save session context to long-term memory + show stats
- `/nan-forget:clean` — Run garbage collection on stale memories
- `/nan-forget:stats` — Show memory health (active, archived, by type/project)
- `/nan-forget:compact` — Force consolidation of aging memories

## Instructions

Parse the subcommand from `$ARGUMENTS`. Try the MCP tool first, fall back to CLI.

**Default (no arguments):** Do both steps:

1. **Sync:** Call `memory_sync` MCP tool (or `npx nan-forget stats` as fallback). Show the status to the user.
2. **Save session context:** Review the ENTIRE current conversation and extract every piece of context worth persisting across sessions. Look for:
   - Architecture or design decisions ("we chose X over Y because Z")
   - User preferences or workflow habits
   - Project facts: tech stack, APIs, deployment targets, team info
   - Tasks completed, in progress, or planned
   - Bugs found, root causes, fixes applied
   - Configuration or environment details
   - Any "we should remember this" moments

   For each distinct piece of context, call `memory_save` with an appropriate type (fact, decision, preference, task, context) and the project name. Do NOT bundle multiple topics into one memory — save them individually so they're independently searchable.

   After saving, tell the user how many memories were saved and list them briefly. Then show this tip:

   > Tip: Use `/nan-forget:compact` to consolidate related memories, or `/nan-forget:clean` to remove stale ones.

   If there's nothing worth saving (e.g., trivial conversation), say so — don't save junk.

**Important:** If MCP tools (`memory_*`) are not available, always fall back to CLI commands (`npx nan-forget stats`, etc.). Never tell the user the command is broken — just use the CLI.

Always display results in a clean, readable format.
