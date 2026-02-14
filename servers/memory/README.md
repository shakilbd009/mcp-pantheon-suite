# MCP Memory Server

Structured long-term memory for AI agents. Store observations, learnings, facts, patterns, and preferences that persist across sessions. Memories are tagged for retrieval and ranked by importance.

## Features

- **5 memory types:** fact, learning, preference, observation, pattern
- **Tag-based retrieval:** Search by any combination of tags
- **Text search:** LIKE-based content search
- **Importance ranking:** Results sorted by importance (1-10 scale)
- **Access tracking:** Automatic access count and last-accessed timestamps
- **Agent-scoped:** Each agent's memories are isolated by `MCP_AGENT_NAME`

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `MCP_DB_PATH` | SQLite database file path | `~/.mcp-suite/memory.db` |
| `MCP_AGENT_NAME` | Agent identity (scopes memories) | `default` |

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mcp-pantheon-suite/servers/memory/index.js"],
      "env": {
        "MCP_AGENT_NAME": "claude"
      }
    }
  }
}
```

## Tools (5)

| Tool | Description |
|---|---|
| `store_memory` | Save a new memory with type, tags, importance, and content |
| `recall` | Search memories by tags, text query, and/or type (ranked by importance) |
| `list_memories` | List all memories, optionally filtered by type |
| `update_memory` | Update a memory's content, importance, or tags |
| `forget` | Delete a memory by ID |

## Examples

### 1. Store and recall a memory

```
> store_memory(content: "Production DB is on port 5433, not default 5432", memory_type: "fact", tags: ["database", "production"], importance: 8)
Memory stored: a1b2c3d4
Type: fact | Importance: 8/10
Tags: database, production

> recall(tags: ["database"])
[a1b2c3d4] (fact, importance: 8/10) Production DB is on port 5433, not default 5432
  Tags: database, production | Created: 2026-01-15T10:30:00Z | Accessed: 1x
```

### 2. Search by text query

```
> recall(query: "retry", memory_type: "learning")
[e5f6g7h8] (learning, importance: 6/10) Retrying after 30s fixes the flaky integration test on CI
  Tags: testing, ci, reliability | Created: 2026-01-10T14:20:00Z | Accessed: 3x
```

### 3. Update and forget

```
> update_memory(memory_id: "a1b2c3d4", importance: 10, tags: ["database", "production", "critical"])
Memory "a1b2c3d4" updated.

> forget(memory_id: "e5f6g7h8")
Memory "e5f6g7h8" deleted.
```

## Data Storage

All data is stored in a single SQLite file with WAL mode. The database and table are auto-created on first run — no setup required. Memories are scoped by agent name, so multiple agents can share the same database file without conflicts.

See `schema.sql` for the full table definition.
