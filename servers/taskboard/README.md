# MCP Taskboard Server

A full-featured sprint board MCP server with two status pipelines, subtasks, task dependencies (with cycle detection), acceptance criteria checklists, full-text search, and cross-cutting initiatives.

## Features

- **Two pipelines:** 9-stage dev lifecycle (`forge/*` projects) and 4-stage lightweight flow (`ops/*` projects)
- **Subtasks:** One level of nesting with done-guard (parent can't close until children are done)
- **Dependencies:** Block/unblock with BFS circular dependency detection
- **Acceptance criteria:** Checkable requirement lists per task
- **Reviews:** Structured verdict system (approve/reject) with categories
- **FTS5 search:** Full-text search across task titles and descriptions (with LIKE fallback)
- **Initiatives:** Cross-cutting goals that link multiple tasks with progress tracking
- **Status history:** Duration tracking between transitions

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `MCP_DB_PATH` | SQLite database file path | `~/.mcp-suite/taskboard.db` |
| `MCP_AGENT_NAME` | Identity for audit trails | `default` |

### Claude Desktop

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
    }
  }
}
```

## Tools (19)

### Task Management

| Tool | Description |
|---|---|
| `create_task` | Create a task with project, title, priority, assignee, due date |
| `list_tasks` | List tasks with filters (project, status, assignee, limit) |
| `search_tasks` | Full-text search across tasks |
| `get_task` | Get full task details with comments, reviews, criteria, deps |
| `update_task` | Update any task field; validates status transitions |
| `delete_task` | Delete a task and all related data (requires confirmation) |

### Comments & Reviews

| Tool | Description |
|---|---|
| `add_comment` | Add a comment to a task |
| `submit_review` | Submit a structured review verdict (approve/reject) with categories |

### Acceptance Criteria

| Tool | Description |
|---|---|
| `set_criteria` | Set a checklist of acceptance criteria on a task |
| `check_criterion` | Check or uncheck a criterion by ID |

### Sprint Board

| Tool | Description |
|---|---|
| `get_board` | Get a visual sprint board for a project (tasks grouped by status) |

### Dependencies

| Tool | Description |
|---|---|
| `add_dependency` | Add a blocking dependency between tasks |
| `remove_dependency` | Remove a dependency link |

### Initiatives

| Tool | Description |
|---|---|
| `create_initiative` | Create a cross-cutting initiative with participants and criteria |
| `list_initiatives` | List initiatives with filters |
| `get_initiative` | Get full initiative details with linked tasks and updates |
| `update_initiative` | Update initiative status, progress, participants, etc. |
| `link_task_to_initiative` | Link a task to an initiative with a role description |
| `add_initiative_update` | Log a progress note on an initiative |

## Status Pipelines

### Full Dev Lifecycle (default)

```
backlog → specced → designed → ready → in_progress → in_review → testing → acceptance → done
```

Use for software projects. Each transition is validated — you can't skip stages.

### Lightweight Flow (`ops/*` projects)

```
todo → in_progress → blocked → done
```

Use for non-engineering work. Prefix your project name with `ops/` to activate.

## Examples

### 1. Create and manage a task

```
> create_task(project: "my-app", title: "Add user auth", priority: 2, assigned_to: "alice")
Task created: a1b2c3d4 — "Add user auth" [backlog] in project my-app

> update_task(task_id: "a1b2c3d4", status: "specced")
Task a1b2c3d4 updated: status

> set_criteria(task_id: "a1b2c3d4", criteria: ["JWT tokens implemented", "Login endpoint returns 200", "Tests cover auth middleware"])
Set 3 acceptance criteria on task a1b2c3d4
```

### 2. Set up dependencies

```
> create_task(project: "my-app", title: "Design database schema", priority: 1)
Task created: e5f6g7h8

> create_task(project: "my-app", title: "Implement API endpoints", priority: 2)
Task created: i9j0k1l2

> add_dependency(task_id: "i9j0k1l2", depends_on_id: "e5f6g7h8")
Dependency added: "Implement API endpoints" is now blocked by "Design database schema"
```

### 3. Track an initiative

```
> create_initiative(title: "Q1 Launch", participants: ["alice", "bob"], criteria: ["All features shipped", "Docs complete"])
Initiative created: m3n4o5p6 — "Q1 Launch"

> link_task_to_initiative(initiative_id: "m3n4o5p6", task_id: "a1b2c3d4", role: "core auth feature")
Task "Add user auth" linked to initiative "Q1 Launch" (role: core auth feature)

> add_initiative_update(initiative_id: "m3n4o5p6", update_text: "Auth feature in review, on track for launch")
Update logged on "Q1 Launch"
```

## Data Storage

All data is stored in a single SQLite file with WAL mode for concurrent read access. The database and tables are auto-created on first run — no setup required.

See `schema.sql` for the full table definitions.
