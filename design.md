# Design: MCP Server Suite — Open Source Release

## Overview

Package 3 production MCP servers from the Clawd agent system into a standalone open-source monorepo called `mcp-pantheon-suite`. The servers — taskboard (sprint board with dependencies, initiatives, FTS5), memory (structured agent memory), and planner (multi-step action plans) — will be sanitized of all internal references, made self-contained with auto-setup, and documented for immediate use with Claude Desktop or any MCP client.

**Goal:** Career leverage — public proof of production MCP expertise for 656+ MCP-related job postings.

## Architecture

```
mcp-pantheon-suite/
├── README.md                 ← Suite overview, quickstart, Claude Desktop config
├── LICENSE                   ← MIT
├── package.json              ← npm workspaces root
├── shared/
│   └── db.js                 ← Shared SQLite utilities (getDb, uuid, now)
├── servers/
│   ├── taskboard/
│   │   ├── package.json      ← @mcp-suite/taskboard
│   │   ├── README.md         ← All 15 tools documented with examples
│   │   ├── index.js          ← Server entry point (~1100L sanitized)
│   │   └── schema.sql        ← Reference DDL (auto-applied by index.js)
│   ├── memory/
│   │   ├── package.json      ← @mcp-suite/memory
│   │   ├── README.md         ← All 5 tools documented with examples
│   │   ├── index.js          ← Server entry point (~250L sanitized)
│   │   └── schema.sql        ← Reference DDL
│   └── planner/
│       ├── package.json      ← @mcp-suite/planner
│       ├── README.md         ← All 6 tools documented with examples
│       ├── index.js          ← Server entry point (~330L sanitized)
│       └── schema.sql        ← Reference DDL
└── blog/
    └── OUTLINE.md            ← Blog post outline (not shipped in npm)
```

### Component Responsibilities

- **shared/db.js** — Singleton SQLite connection, WAL mode, busy_timeout, UUID generation, ISO timestamps. Does NOT create tables — each server does its own schema setup.
- **servers/taskboard/index.js** — 15 MCP tools: task CRUD, status pipelines (forge 9-stage + ops 4-stage), subtasks, dependencies (with BFS cycle detection), comments, reviews, acceptance criteria, sprint board, FTS5 search, initiatives.
- **servers/memory/index.js** — 5 MCP tools: store, recall (text + tags + type), list, update, forget. Memories scoped by agent name.
- **servers/planner/index.js** — 6 MCP tools: create, update_step, get, list, complete, abandon. One active plan per agent. Auto-complete when all steps done/skipped.

### Data Flow

```
Claude Desktop / MCP Client
       │
       ├── stdio ──→ taskboard server ──→ ~/.mcp-suite/taskboard.db
       ├── stdio ──→ memory server    ──→ ~/.mcp-suite/memory.db
       └── stdio ──→ planner server   ──→ ~/.mcp-suite/planner.db
```

Each server is independent. They share no database. They share only the `shared/db.js` utility module.

## Technical Decisions

### 1. Separate databases per server (not one shared DB)

**Decision:** Each server gets its own SQLite file at `~/.mcp-suite/<server>.db`.

**Rationale:** The original system used one shared DB because the daemon needed cross-server queries. Open-source users won't have a daemon — each server runs independently. Separate DBs prevent schema collisions, simplify backup/reset, and make each server truly standalone.

**Considered Alternatives:**
- **Single shared DB (like original):** Rejected — couples servers unnecessarily, creates confusion about which tables belong to which server, and a bug in one server's migration could break another.
- **In-memory DB option:** Rejected — no persistence across restarts defeats the purpose of memory and planner servers.

### 2. Remove logToolCall audit logging entirely

**Decision:** Strip all `logToolCall()` calls and the `tool_calls` table from the open-source version.

**Rationale:** The audit log was built for the AED daemon to monitor agent tool usage. Open-source users have no dashboard to view it. It adds a table nobody will query, inflates DB size, and creates confusion. Every tool handler becomes simpler (fewer lines, clearer error handling).

**Considered Alternatives:**
- **Keep as opt-in via env var:** Rejected — adds complexity for zero user value. If someone wants logging, they can add it themselves.
- **Replace with console.error for errors only:** Considered but unnecessary — MCP protocol already surfaces errors to the client.

### 3. Schema auto-setup via init function per server

**Decision:** Each server calls an `initSchema(db)` function at startup that runs `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements. The schema is also saved as `schema.sql` for reference (not executed directly).

**Rationale:** Users must not need a migration step. `CREATE IF NOT EXISTS` is idempotent — safe to run every startup. Keeping schema in JS (not loading from .sql file) avoids file-path resolution issues when running via npx.

**Considered Alternatives:**
- **Load schema.sql at runtime:** Rejected — file path resolution breaks when run via npx or from different working directories. Embedding SQL strings in JS is more reliable.
- **Migration system (versioned):** Rejected — over-engineering for v1. No schema changes expected. Can add later if needed.

### 4. shared/db.js design — factory pattern with per-server defaults

**Decision:** `shared/db.js` exports a `createDb(serverName)` function that:
1. Reads `MCP_DB_PATH` env var (overrides default path)
2. Falls back to `~/.mcp-suite/<serverName>.db`
3. Creates the directory if it doesn't exist (`mkdirSync` with `recursive: true`)
4. Opens SQLite with WAL mode and busy_timeout=5000
5. Returns the db instance (singleton per process)

Also exports: `uuid8()` (8-char UUID), `now()` (ISO timestamp), `getAgentName()` (reads `MCP_AGENT_NAME`, defaults to `"default"`).

**Rationale:** Factory pattern lets each server specify its DB name while sharing connection logic. Default path (`~/.mcp-suite/`) follows XDG-like convention for CLI tools. Directory auto-creation prevents "SQLITE_CANTOPEN" errors on first run.

**Considered Alternatives:**
- **Each server manages its own DB setup:** Rejected — duplicates ~20 lines across 3 servers, violates DRY for identical logic.
- **Single getDb() like original:** Rejected — original required `AED_DB_PATH` to be set. Open-source version needs sensible defaults.

### 5. Environment variable naming

**Decision:** Rename `AED_DB_PATH` → `MCP_DB_PATH`, `AED_AGENT_NAME` → `MCP_AGENT_NAME`.

**Rationale:** Generic prefix (`MCP_`) makes sense for open-source. Matches the MCP ecosystem naming convention.

### 6. pending_events bridge removal

**Decision:** Remove the `pending_events` INSERT block in taskboard's `update_task` (original lines 521-534). This was a daemon-specific event bus bridge.

**Rationale:** The pending_events table only exists in the AED daemon's DB. It triggers agent wakes on status changes — irrelevant for standalone use. The try/catch around it already treated it as non-fatal.

### 7. npm workspaces structure

**Decision:** Root `package.json` defines workspaces: `["shared", "servers/*"]`. Each server's `package.json` declares its own dependencies (`@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`) and a `bin` entry pointing to `index.js` for npx support.

**Rationale:** Workspaces enable `npm install` at root to install all deps. Each server is independently runnable. `bin` entry enables `npx @mcp-suite/taskboard` once published (future).

**Considered Alternatives:**
- **No workspaces, flat deps:** Rejected — triplicate dependencies, harder to manage.
- **Turborepo/Lerna:** Rejected — over-engineering for 3 small packages with no build step.

### 8. Status transition validation preserved as-is

**Decision:** Keep both the Forge (9-stage) and Ops (4-stage) pipelines with their transition maps. The `ops/*` prefix detection stays.

**Rationale:** The dual-pipeline design is a key portfolio differentiator — it shows real-world complexity. The pipeline is useful for anyone building a task management system, not just the Forge.

## Implementation Plan

### Task 1 (P1): Create shared/db.js and project scaffolding
- Create `shared/db.js` with `createDb(serverName)`, `uuid8()`, `now()`, `getAgentName()`
- Create `shared/package.json` (name: `@mcp-suite/shared`, no bin)
- Create root `package.json` with workspaces
- Create `LICENSE` (MIT)
- **No README yet** — written after servers exist so examples are accurate

### Task 2 (P1): Sanitize and package taskboard server
- Copy `mcp-taskboard.js` → `servers/taskboard/index.js`
- Sanitize: `AED_*` → `MCP_*`, remove pending_events bridge, remove all logToolCall calls, remove "Forge" and "AED" from tool descriptions, rename server from "aed-taskboard" to "mcp-taskboard"
- Add `initSchema(db)` function with CREATE TABLE IF NOT EXISTS for: `forge_tasks` (rename to `tasks`), `forge_task_comments` (→ `task_comments`), `forge_task_deps` (→ `task_deps`), `forge_task_history` (→ `task_history`), `forge_tasks_fts` (→ `tasks_fts`), `initiatives`, `initiative_tasks`, `initiative_updates`
- Update all SQL queries to use new table names
- Import from `../../shared/db.js`
- Create `servers/taskboard/package.json`
- Extract DDL to `servers/taskboard/schema.sql`
- Write `servers/taskboard/README.md` with all 15 tools and 3+ examples

### Task 3 (P1): Sanitize and package memory server
- Copy `mcp-memory.js` → `servers/memory/index.js`
- Sanitize: `AED_*` → `MCP_*`, remove logToolCall calls, rename "aed-memory" → "mcp-memory"
- Add `initSchema(db)` with CREATE TABLE for `memories` (renamed from `agent_memories`)
- Update SQL queries for new table name
- Import from `../../shared/db.js`
- Create `servers/memory/package.json`
- Extract DDL to `servers/memory/schema.sql`
- Write `servers/memory/README.md` with all 5 tools and 3+ examples

### Task 4 (P1): Sanitize and package planner server
- Copy `mcp-planner.js` → `servers/planner/index.js`
- Sanitize: `AED_*` → `MCP_*`, remove logToolCall calls, rename "aed-planner" → "mcp-planner"
- Add `initSchema(db)` with CREATE TABLE for `plans` (renamed from `action_plans`)
- Update SQL queries for new table name
- Import from `../../shared/db.js`
- Create `servers/planner/package.json`
- Extract DDL to `servers/planner/schema.sql`
- Write `servers/planner/README.md` with all 6 tools and 3+ examples

### Task 5 (P2): Write suite README and blog outline
- Write root `README.md`: pitch paragraph, ASCII architecture diagram, 3-step quickstart, Claude Desktop config for all 3 servers, per-server summaries with links, "Built with" section, license badge
- Write `blog/OUTLINE.md` with 5 sections per spec

## Data Model

### Taskboard tables (renamed from forge_*)

```sql
-- tasks (was forge_tasks)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  assigned_to TEXT,
  priority INTEGER DEFAULT 5,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_task_id TEXT REFERENCES tasks(id),
  branch TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_merged INTEGER DEFAULT 0,
  spec_file TEXT,
  design_file TEXT,
  criteria TEXT,
  due_date TEXT
);

-- task_comments (was forge_task_comments)
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'comment',
  verdict TEXT,
  categories TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- task_deps (was forge_task_deps)
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (task_id, depends_on_id)
);

-- task_history (was forge_task_history)
CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  duration_seconds INTEGER
);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, description, content=tasks, content_rowid=rowid
);

-- Initiatives
CREATE TABLE IF NOT EXISTS initiatives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  owner TEXT,
  participating_agents TEXT DEFAULT '[]',
  success_criteria TEXT DEFAULT '[]',
  progress_pct INTEGER DEFAULT 0,
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS initiative_tasks (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT DEFAULT '',
  linked_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(initiative_id, task_id)
);

CREATE TABLE IF NOT EXISTS initiative_updates (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  agent_name TEXT NOT NULL,
  update_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Memory table (renamed from agent_memories)

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'observation',
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 5,
  access_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(agent_name, memory_type);
```

### Planner table (renamed from action_plans)

```sql
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  title TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  progress TEXT DEFAULT '0/0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_name);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(agent_name, status);
```

## Dependencies

All servers share the same dependency set:
- `@modelcontextprotocol/sdk` ^1.0.0 — MCP protocol implementation
- `zod` ^3.22.0 — Schema validation for tool parameters
- `better-sqlite3` ^11.0.0 — SQLite driver with WAL support

No other dependencies. Zero framework bloat.

## Risks

1. **Table rename breaks existing users** — Anyone who somehow runs this against an existing AED database will get empty tables. Mitigation: these are new independent DBs, not upgrades. Document clearly.

2. **FTS5 availability** — Some SQLite builds lack FTS5. The taskboard already handles this with a LIKE fallback (try/catch on FTS query). No mitigation needed — existing pattern is correct.

3. **npx first-run DB creation** — When running via npx, the working directory may be unexpected. The `~/.mcp-suite/` default path uses the home directory, which is always writable. Mitigation: `createDb()` uses `os.homedir()` not `process.cwd()`.

4. **Relative import paths** — `../../shared/db.js` works in the monorepo but breaks if someone copies a single server out. Mitigation: document that servers should be used within the monorepo. If published to npm individually later, shared/db.js would need to be a proper npm dependency.

5. **Sanitization completeness** — Risk of missing an internal reference. Mitigation: spec provides a grep command to verify: `grep -r "clawd\|colonial\|hermes\|hephaestus\|arachne\|AED_\|/Users/" servers/` must return zero matches.
