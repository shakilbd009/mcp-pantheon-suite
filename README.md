# MCP Pantheon Suite

Production MCP servers for AI agent systems. Three servers — **taskboard**, **memory**, **planner** — built and battle-tested across 13 autonomous agents. Drop-in tools for Claude Desktop or any MCP client.

30 tools. Zero configuration. SQLite-backed.

## Architecture

```
┌─────────────────┐
│  Claude / LLM    │
│  (MCP Client)    │
└───────┬─────────┘
        │ stdio (JSON-RPC)
        ├──────────────────────────────────────┐
        │                                      │
        ▼                                      ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│   Taskboard   │  │    Memory     │  │    Planner    │
│   19 tools    │  │    5 tools    │  │    6 tools    │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                   │
        ▼                  ▼                   ▼
   taskboard.db       memory.db           planner.db
   (SQLite WAL)      (SQLite WAL)        (SQLite WAL)
```

Each server manages its own SQLite database. Tables are auto-created on first run — no setup required.

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/shakilbd009/mcp-pantheon-suite.git
cd mcp-pantheon-suite
npm install

# 2. Configure Claude Desktop (see below)
# 3. Restart Claude Desktop — 30 tools available
```

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "taskboard": {
      "command": "node",
      "args": ["/path/to/mcp-pantheon-suite/servers/taskboard/index.js"],
      "env": {
        "MCP_AGENT_NAME": "claude"
      }
    },
    "memory": {
      "command": "node",
      "args": ["/path/to/mcp-pantheon-suite/servers/memory/index.js"],
      "env": {
        "MCP_AGENT_NAME": "claude"
      }
    },
    "planner": {
      "command": "node",
      "args": ["/path/to/mcp-pantheon-suite/servers/planner/index.js"],
      "env": {
        "MCP_AGENT_NAME": "claude"
      }
    }
  }
}
```

Replace `/path/to/mcp-pantheon-suite` with your actual install path.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MCP_DB_PATH` | Override database file path | `~/.mcp-suite/<server>.db` |
| `MCP_AGENT_NAME` | Agent identity for scoping data | `default` |

## Servers

### Taskboard (19 tools)

Full-featured sprint board with two status pipelines, subtasks, task dependencies (with BFS cycle detection), acceptance criteria checklists, structured reviews, full-text search, and cross-cutting initiatives.

**Pipelines:**
- **Dev lifecycle** (9 stages): `backlog → specced → designed → ready → in_progress → in_review → testing → acceptance → done`
- **Lightweight** (`ops/*` projects, 4 stages): `todo → in_progress → blocked → done`

**Key tools:** `create_task`, `update_task`, `get_board`, `search_tasks`, `add_dependency`, `submit_review`, `create_initiative`

[Full documentation →](servers/taskboard/README.md)

### Memory (5 tools)

Structured long-term memory for AI agents. Store observations, learnings, facts, patterns, and preferences that persist across sessions. Tag-based retrieval with importance ranking and access tracking.

**Memory types:** fact, learning, preference, observation, pattern

**Key tools:** `store_memory`, `recall`, `update_memory`, `forget`

[Full documentation →](servers/memory/README.md)

### Planner (6 tools)

Multi-step action plan tracking. Create plans with ordered steps, track progress across sessions, auto-complete when done. Only one active plan per agent — new plans supersede the previous one.

**Step statuses:** pending, in_progress, done, blocked, skipped

**Key tools:** `create_plan`, `update_step`, `get_plan`, `abandon_plan`

[Full documentation →](servers/planner/README.md)

## Shared Utilities

All servers import from `shared/db.js`:

- `createDb(serverName)` — SQLite connection factory with WAL mode and busy timeout
- `getAgentName()` — Agent identity from `MCP_AGENT_NAME` env var
- `uuid8()` — 8-character UUID prefix generator
- `now()` — ISO 8601 timestamp

## Built With

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — Synchronous SQLite for Node.js
- [Zod](https://github.com/colinhacks/zod) — Schema validation for tool inputs
- Node.js 18+

## License

MIT — see [LICENSE](LICENSE).
