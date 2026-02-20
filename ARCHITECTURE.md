# ARCHITECTURE.md — mcp-pantheon-suite

> Last updated: 2026-02-16 by Metis (Strategic Architect) — Cycle 3 in progress

> Three MCP servers for AI agent orchestration: task management, persistent memory, and action planning.

## System Overview

```
mcp-pantheon-suite/
├── shared/
│   ├── db.js             ← SQLite factory + helpers (singleton per process, 57 lines)
│   ├── db.test.js        ← DB utility tests (102 lines)
│   ├── query.js          ← Dynamic WHERE/SET builders + safeJsonParse (68 lines)
│   └── query.test.js     ← Query helper tests (129 lines)
├── servers/
│   ├── taskboard/        ← Sprint board with 19 tools + 7 handler modules + tests (319 lines)
│   ├── memory/           ← Agent memory with 5 tools + handlers (174 lines) + tests (188 lines)
│   └── planner/          ← Action plans with 6 tools + handlers (284 lines) + tests (188 lines)
├── tests/
│   └── integration/      ← MCP JSON-RPC integration harness + tests (58 lines)
└── blog/OUTLINE.md       ← Blog post outline (not shipped)
```

Each server is a standalone MCP stdio process. All three share SQLite and query utility modules but run independently with separate databases by default.

## Data Access

**Connection:** Module-level singleton via `createDb(serverName)`. One connection per process lifetime.

**Default path:** `~/.mcp-suite/<serverName>.db` (e.g., `~/.mcp-suite/taskboard.db`).
Override: `MCP_DB_PATH` environment variable points all three at one DB or uses separate DBs.

**Settings:** WAL mode, 5s busy timeout. Tables auto-created via `CREATE TABLE IF NOT EXISTS`.

**SQL:** 100% parameterized queries. Dynamic WHERE/SET clauses built via `shared/query.js` helpers (`buildWhereClause`, `buildSetClause`). Column names validated against per-handler allowlist Sets (defense-in-depth against column injection). No ORM.

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Separate DBs per server (default) | Isolation — one server's schema changes don't affect others |
| No audit logging | Open-source users have no dashboard to consume it; reduces DB bloat |
| Zod for parameter validation | MCP SDK integrates Zod natively for tool schemas |
| FTS5 with LIKE fallback | Full-text search where available, graceful degradation where not |
| npm workspaces monorepo | Shared code without publishing to npm registry |
| No logging framework | MCP servers communicate via stdio; console output would corrupt the protocol |
| Column allowlists on query builders | Defense-in-depth — prevents column injection if future code passes user-derived column names. Hard-coded Sets per handler, not schema introspection |
| Taskboard handler split (7 modules) | 956-line monolith → tasks, initiatives, comments, criteria, dependencies, projects, schema. Each module under 200 lines |

## Error Handling

Uniform pattern across all servers:
- Every tool handler wrapped in try-catch
- Errors returned as `{ isError: true, content: [{ text: "Error: ..." }] }`
- Schema validation happens before handler via Zod (MCP SDK enforces this)
- FTS5 has explicit fallback to LIKE queries
- JSON parsing uses `safeJsonParse(str, defaultValue, context)` — logs warnings on corruption instead of crashing or silently returning empty data

## Conventions

- **IDs:** 8-character UUID prefix (`uuid8()`)
- **Timestamps:** `new Date().toISOString()` — always UTC
- **Agent identity:** `MCP_AGENT_NAME` env var, defaults to `"default"`
- **Status flows:** Taskboard has 11 statuses (forge pipeline + ops pipeline); Memory/Planner have simpler states

## Relationship to clawd-aed

This is an open-source fork of three internal MCP servers from the [Agent Execution Daemon](https://github.com/shakilbd009/clawd-aed). Key differences from the internal versions:

| Aspect | clawd-aed (internal) | mcp-pantheon-suite (open-source) |
|--------|---------------------|----------------------------------|
| DB path | `AED_DB_PATH` (required) | `MCP_DB_PATH` or `~/.mcp-suite/` |
| Agent name env | `AED_AGENT_NAME` | `MCP_AGENT_NAME` |
| Audit logging | `logToolCall()` → `tool_calls` table | Removed |
| DB topology | Single shared SQLite | Separate DB per server (default) |
| Dependency floor | `@modelcontextprotocol/sdk ^1.12.0` | `^1.0.0` |

## Testing

**Framework:** Vitest (ESM-native, compatible with the project's `"type": "module"` setting).

| Test Suite | Location | Lines | Coverage |
|-----------|----------|-------|----------|
| shared/db | `shared/db.test.js` | 102 | SQLite factory, helpers, WAL mode |
| shared/query | `shared/query.test.js` | 169 | WHERE/SET builders, column allowlists, safeJsonParse edge cases |
| taskboard | `servers/taskboard/index.test.js` | 319 | Handler extraction, CRUD ops, status flows |
| memory | `servers/memory/index.test.js` | 187 | Store, recall, update, delete, search |
| planner | `servers/planner/index.test.js` | 188 | Plan lifecycle, step updates, completion |
| integration (harness) | `tests/integration/harness.test.js` | 4 | MCP JSON-RPC client smoke tests |
| integration (memory) | `tests/integration/memory.test.js` | 3 | E2E memory server round-trips |
| integration (taskboard) | `tests/integration/taskboard.test.js` | 3 | E2E taskboard server round-trips |
| integration (planner) | `tests/integration/planner.test.js` | 3 | E2E planner server round-trips |

**Totals:** 73 unit tests + 13 integration tests = **86 tests**.

**Integration harness** (`tests/integration/harness.js`): Spawns an MCP server as a child process, communicates via JSON-RPC over stdio. Manages MCP init handshake, timeout handling, and clean process teardown (SIGTERM → SIGKILL cascade). Validates tool calls work end-to-end through the MCP protocol layer, not just handler functions.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation (stdio transport)
- `better-sqlite3` — Synchronous SQLite (native addon, requires compilation)
- `zod` — Schema validation (used by MCP SDK for tool parameters)
- `vitest` — Test framework (dev dependency)
