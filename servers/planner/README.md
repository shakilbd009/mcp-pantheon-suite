# MCP Planner Server

Multi-step action plan tracking for AI agents. Create plans with ordered steps, track progress across sessions, and complete or abandon plans when done. Only one active plan per agent at a time — creating a new plan automatically supersedes the previous one.

## Features

- **Ordered steps:** Each plan has numbered steps with status tracking
- **Step statuses:** pending, in_progress, done, blocked, skipped
- **Auto-completion:** Plan auto-completes when all steps are done or skipped
- **Supersede on create:** New plan automatically supersedes any existing active plan
- **Abandonment tracking:** Abandoned plans record the reason as a final step
- **Agent-scoped:** Each agent has independent plans via `MCP_AGENT_NAME`

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `MCP_DB_PATH` | SQLite database file path | `~/.mcp-suite/planner.db` |
| `MCP_AGENT_NAME` | Agent identity (scopes plans) | `default` |

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
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

## Tools (6)

| Tool | Description |
|---|---|
| `create_plan` | Create a new plan with a title and ordered steps (max 20) |
| `update_step` | Update a step's status and add optional notes |
| `get_plan` | Get the current active plan or a specific plan by ID |
| `list_plans` | List recent plans filtered by status |
| `complete_plan` | Mark the active plan as completed |
| `abandon_plan` | Abandon the active plan with a reason |

## Examples

### 1. Create a plan and track steps

```
> create_plan(title: "Deploy auth service", steps: ["Write JWT middleware", "Add login endpoint", "Write tests", "Deploy to staging"])
Plan created: a1b2c3d4

Plan: Deploy auth service [active] (0/4)
ID: a1b2c3d4 | Created: 2026-01-15T10:00:00Z

  ○ Step 1: Write JWT middleware [pending]
  ○ Step 2: Add login endpoint [pending]
  ○ Step 3: Write tests [pending]
  ○ Step 4: Deploy to staging [pending]

> update_step(step_id: 1, status: "done", notes: "Using RS256 algorithm")
Step 1 → done (1/4)

> update_step(step_id: 2, status: "in_progress")
Step 2 → in_progress (1/4)
```

### 2. Get current plan

```
> get_plan()
Plan: Deploy auth service [active] (1/4)
ID: a1b2c3d4 | Created: 2026-01-15T10:00:00Z

  ✓ Step 1: Write JWT middleware [done] — Using RS256 algorithm
  ▸ Step 2: Add login endpoint [in_progress]
  ○ Step 3: Write tests [pending]
  ○ Step 4: Deploy to staging [pending]
```

### 3. List and abandon plans

```
> list_plans(status: "all")
▸ [a1b2c3d4] Deploy auth service (1/4) [active] — 2026-01-15T11:00:00Z
✓ [e5f6g7h8] Setup CI pipeline (3/3) [completed] — 2026-01-14T16:00:00Z

> abandon_plan(reason: "Switching to OAuth2 instead of custom JWT")
Plan "Deploy auth service" abandoned. Reason: Switching to OAuth2 instead of custom JWT
```

## Data Storage

All data is stored in a single SQLite file with WAL mode. The database and table are auto-created on first run — no setup required. Plans are scoped by agent name, so multiple agents can share the same database file.

See `schema.sql` for the full table definition.
