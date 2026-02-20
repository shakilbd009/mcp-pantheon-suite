# Spec: MCP Server Suite — Open Source Release

## Overview

Package 3 production MCP servers from the Clawd agent system as a standalone open-source suite. The goal is career leverage: 656 job postings mention MCP, and Shakil has zero public proof of expertise. This suite demonstrates production-grade MCP server development with real-world complexity (not toy examples).

**Approach chosen:** Monorepo with 3 standalone servers. Each server is self-contained with its own package.json, auto-creates its SQLite database, and works immediately with Claude Desktop or any MCP client. Chosen over 3 separate repos for easier maintenance and stronger portfolio signal ("a suite, not a hello-world").

## User Stories

- As a hiring manager reviewing Shakil's GitHub, I want to see production MCP servers with real complexity so I can assess his MCP expertise in under 5 minutes.
- As a developer building an AI agent system, I want drop-in MCP servers for task management, agent memory, and action planning so I don't have to build these from scratch.
- As a Claude Desktop user, I want to add a taskboard/memory/planner to my setup with a single `npx` command and minimal config.

## Requirements

### Functional

#### Server 1: `@mcp-suite/taskboard` (from mcp-taskboard.js)

1. **Task CRUD** — Create, list, get, update, delete tasks with project grouping. Each operation must work standalone (no daemon dependency).
2. **Status pipelines** — Two built-in pipelines: a 9-stage software dev lifecycle (`backlog → specced → designed → ready → in_progress → in_review → testing → acceptance → done`) and a lightweight ops pipeline (`todo → in_progress → blocked → done`). Pipeline selected by project prefix (`ops/*` = lightweight, everything else = full).
3. **Subtasks** — Tasks can have child tasks (max 1 level deep). Parent cannot be marked done until all children are done.
4. **Dependencies** — Tasks can depend on other tasks. Circular dependency detection via BFS. Add/remove dependency operations.
5. **Comments & reviews** — Add comments to tasks. Submit structured reviews with verdict (approve/reject) and issue categories.
6. **Acceptance criteria** — Set checkable criteria on tasks. Check/uncheck individual criteria items.
7. **Sprint board view** — Get all tasks for a project grouped by status column, with subtask nesting.
8. **Full-text search** — FTS5 search across task titles and descriptions, with LIKE fallback.
9. **Task history** — Record status transitions with timestamps and duration tracking.
10. **Initiatives** — Cross-cutting goals that link multiple tasks. CRUD + progress tracking + updates log.
11. **Auto-setup** — On first run, automatically create all required SQLite tables and FTS indexes. No manual migration step.

#### Server 2: `@mcp-suite/memory` (from mcp-memory.js)

1. **Store memories** — Save structured memories with content, type, tags, and importance (1-10).
2. **Memory types** — 5 types: `fact`, `learning`, `preference`, `observation`, `pattern`. Each with clear semantics described in tool descriptions.
3. **Recall** — Search memories by text query, tags (OR-matched), and/or type. Results ranked by importance, then recency.
4. **Access tracking** — Each recall bumps access_count and last_accessed timestamp on matched memories.
5. **Update & forget** — Update content/importance/tags on existing memories. Delete by ID.
6. **List all** — List memories with optional type filter, showing previews.
7. **Scoped by agent** — Memories are namespaced by `AED_AGENT_NAME` env var (renamed to `MCP_AGENT_NAME` for the open-source version). Different agents/users see only their own memories.
8. **Auto-setup** — Create SQLite table on first run.

#### Server 3: `@mcp-suite/planner` (from mcp-planner.js)

1. **Create plans** — Multi-step action plans with ordered steps (1-20 steps). Creating a new plan auto-supersedes any active plan for the same agent.
2. **Step tracking** — Update step status: `pending`, `in_progress`, `done`, `blocked`, `skipped`. Optional notes per step.
3. **Auto-complete** — When all steps are done or skipped, plan auto-transitions to `completed`.
4. **Get current plan** — Retrieve the active plan with formatted step display (status icons: checkmark, arrow, X, dash, circle).
5. **Plan history** — List recent plans with status filter. Plans have states: `active`, `completed`, `abandoned`, `superseded`.
6. **Abandon plans** — Mark active plan as abandoned with a reason.
7. **Scoped by agent** — Plans are namespaced by agent name.
8. **Auto-setup** — Create SQLite table on first run.

#### Suite-Level

1. **Monorepo structure** — Single repo with `servers/taskboard/`, `servers/memory/`, `servers/planner/` directories.
2. **Shared utilities** — Common `shared/db.js` module for SQLite setup, UUID generation, timestamps, and tool call audit logging.
3. **Environment config** — Each server reads `MCP_DB_PATH` (defaults to `~/.mcp-suite/<server>.db`) and `MCP_AGENT_NAME` (defaults to `default`).
4. **Claude Desktop integration** — README includes copy-paste config for `claude_desktop_config.json`.
5. **npx support** — Each server runnable via `npx @mcp-suite/taskboard` (or direct `node` invocation).

### Non-Functional

- **Zero dependencies beyond MCP SDK** — Only `@modelcontextprotocol/sdk`, `zod`, and `better-sqlite3`. No framework bloat.
- **Startup time** — Server ready in <500ms including DB auto-setup.
- **No data loss** — SQLite WAL mode, busy timeout of 5000ms for concurrent access.
- **No secrets** — All internal references (agent names, file paths, project names, IP addresses) stripped during sanitization.
- **Node.js 18+** — Compatible with Node 18, 20, 22.

## Sanitization Checklist

Remove from source code before publishing:
- [ ] `AED_DB_PATH` → `MCP_DB_PATH`
- [ ] `AED_AGENT_NAME` → `MCP_AGENT_NAME`
- [ ] All references to "AED", "Clawd", "Colonial", agent names (hermes, hephaestus, etc.)
- [ ] Hardcoded file paths (`/Users/hermes/`, `~/clawd/`, etc.)
- [ ] Business logic specific to the Forge pipeline (keep the pipeline itself — it's a good example)
- [ ] Internal comments referencing the daemon or specific architecture
- [ ] The `pending_events` bridge in taskboard (daemon-specific)

## Repository Structure

```
mcp-pantheon-suite/
├── README.md                 ← Suite overview, architecture, quickstart
├── LICENSE                   ← MIT
├── package.json              ← Workspace root (if using npm workspaces)
├── shared/
│   └── db.js                 ← Shared SQLite utils (getDb, uuid, now, logToolCall)
├── servers/
│   ├── taskboard/
│   │   ├── package.json
│   │   ├── README.md         ← Server-specific docs, all tools, 3+ usage examples
│   │   ├── index.js          ← Main server entry point
│   │   └── schema.sql        ← Table definitions (for reference, auto-applied)
│   ├── memory/
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── index.js
│   │   └── schema.sql
│   └── planner/
│       ├── package.json
│       ├── README.md
│       ├── index.js
│       └── schema.sql
└── blog/
    └── OUTLINE.md            ← Blog post outline (not published in repo)
```

## README Requirements

### Suite README.md

- One-paragraph pitch: what this is and why it exists
- Architecture diagram (text/ASCII — shows how servers connect to Claude/LLM via MCP)
- Quickstart: install, configure, run (3 steps max)
- Claude Desktop config snippet (all 3 servers)
- Individual server summaries with links to server READMEs
- "Built with" section: MCP SDK, SQLite, Node.js
- License badge

### Per-Server README.md

- What the server does (1 paragraph)
- All available tools with parameter descriptions
- 3+ usage examples showing realistic tool calls and responses
- Configuration options (env vars, DB path)
- Claude Desktop config snippet (just this server)

## Blog Post: "How I Built 13 Autonomous Agents with MCP"

### Content Requirements

1. **Hook** — "656 job postings mention MCP. Here's what I learned building 13 production MCP servers."
2. **The system** — Brief overview of the multi-agent architecture (without revealing proprietary details)
3. **3 server deep-dives** — For each server: the problem it solves, key design decisions, code snippet
4. **Lessons learned** — SQLite WAL mode for multi-agent, MCP protocol patterns, tool design principles
5. **Call to action** — Link to repo, invite contributions

### Non-Requirements for Blog

- No need for the blog to be publication-ready — an outline with section headers and key points is sufficient for this task. Calliope/Apollo can polish.

## Edge Cases

1. **Empty database** — Each server must work on first run with no pre-existing data. Auto-create tables idempotently (CREATE TABLE IF NOT EXISTS).
2. **Concurrent access** — Two clients connecting to the same server simultaneously. SQLite WAL + busy_timeout handles this, but document the limitation.
3. **Large datasets** — Taskboard with 1000+ tasks. Ensure list operations have `LIMIT` defaults and pagination is clear.
4. **Invalid tool calls** — Missing required params, invalid status transitions, circular dependencies. All must return clear error messages, not crash.
5. **DB file permissions** — If `MCP_DB_PATH` directory doesn't exist, create it. If file is read-only, fail with clear error.

## Non-Goals

- **No web UI** — This is servers only. A dashboard is a separate project.
- **No authentication** — MCP servers are local-first. Auth is out of scope.
- **No remote/cloud deployment** — These run locally alongside Claude Desktop or similar.
- **No npm publish in this iteration** — Package structure should support it, but actual `npm publish` is a follow-up.
- **No tests in v1** — Ship first, add tests in v2. The servers are already battle-tested in production.
- **No CI/CD** — Not needed for initial release.

## Success Criteria

1. All 3 servers start and respond to tool calls without errors on a clean machine with Node 18+.
2. Claude Desktop can connect to each server using the documented config.
3. Every tool in every server has at least one usage example in the README.
4. `grep -r "clawd\|colonial\|hermes\|hephaestus\|arachne\|AED_\|/Users/" servers/` returns zero matches (sanitization complete).
5. Blog post outline covers all 5 sections with enough detail for Calliope/Apollo to expand.
6. Repository has MIT LICENSE file and root README with quickstart.
7. Code pushed to public GitHub repo with descriptive commit history.
