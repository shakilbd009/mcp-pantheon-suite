# Design: Unit Tests for MCP Pantheon Suite

## Overview

Add unit tests for all 30 tool handlers across 3 MCP servers (taskboard, memory, planner) using Vitest with in-memory SQLite. Currently only `shared/db.test.js` exists (standalone Node runner, 80 lines). This design covers the test architecture, handler extraction pattern, and implementation tasks.

## Architecture

### The Testability Problem

Handlers are anonymous functions registered via `server.tool()`, closing over a module-level `db` singleton. They cannot be imported or called directly. Two dependencies need injection: the database connection and the agent name.

### Solution: Extract Handlers into Named Functions

Each server's `index.js` gets a companion `handlers.js` that exports pure handler functions accepting `(db, agentName, params)`. The `index.js` becomes a thin shell: init DB → import handlers → register with MCP server.

**Before (current — taskboard/index.js):**
```javascript
const db = createDb("taskboard");
initSchema(db);

server.tool("create_task", ..., async ({ title, ... }) => {
  const agent = getAgentName();
  const id = uuid8();
  db.prepare("INSERT INTO tasks...").run(id, title);
  return { content: [...] };
});
```

**After (taskboard/handlers.js + index.js):**
```javascript
// handlers.js — testable, no MCP/DB coupling
import { uuid8, now } from "../../shared/db.js";

export function createTask(db, agentName, { title, ... }) {
  const id = uuid8();
  db.prepare("INSERT INTO tasks...").run(id, title);
  return { content: [...] };
}

// index.js — thin MCP registration shell
import { createTask, ... } from "./handlers.js";

const db = createDb("taskboard");
initSchema(db);

server.tool("create_task", ..., async (params) => createTask(db, getAgentName(), params));
```

**Why this approach:**
- Handlers become pure functions testable with any DB instance
- Zero change to MCP protocol behavior — registration is just a wrapper
- `initSchema` stays in `index.js` but is also exported for tests to call
- Agent name becomes an explicit parameter, eliminating env var coupling in tests

### Test Harness

Each test file creates a fresh `:memory:` SQLite database per test suite (using `beforeEach`), calls `initSchema(db)` to set up tables, then calls handler functions directly.

```
servers/
  taskboard/
    index.js        ← thin MCP shell (imports handlers)
    handlers.js     ← extracted handler logic (NEW)
    index.test.js   ← tests import handlers.js directly (NEW)
  memory/
    index.js
    handlers.js     (NEW)
    index.test.js   (NEW)
  planner/
    index.js
    handlers.js     (NEW)
    index.test.js   (NEW)
shared/
  db.js
  db.test.js        ← migrated to vitest format
```

### Test Isolation

Each `describe` block (or each `it` block for stateful tests) gets its own `:memory:` DB via `beforeEach`. No shared state between test cases. No file system side effects.

```javascript
import Database from "better-sqlite3";
import { initSchema } from "./index.js";
import { createTask, ... } from "./handlers.js";

let db;
beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});
afterEach(() => db.close());
```

## Technical Decisions

### Decision 1: Extract handlers vs. test wrapper

**Chosen: Handler extraction.** Extract handler logic into `handlers.js` per server.

**Rejected alternatives:**
- **Test wrapper (mock MCP server):** Would avoid touching production code, but requires reimplementing MCP request/response format. Fragile — breaks when SDK changes. Tests would be testing the wrapper, not the handlers.
- **Singleton reset (monkey-patch `_db`):** Minimal change, but `_db` is module-private. Would require exporting a `_resetDb()` hack. ES module caching makes per-test resets unreliable.

Handler extraction is a standard testability pattern. The refactor is mechanical (move function body → add `db`/`agentName` params). No behavioral change.

### Decision 2: One DB per describe block vs. per test

**Chosen: One DB per `beforeEach` (per test case).** Full isolation. In-memory SQLite creation is ~1ms — no performance concern for 31+ tests.

**Rejected:** Shared DB with cleanup. Fragile — forgotten cleanup causes cross-test contamination. Not worth the complexity.

### Decision 3: FTS5 handling

**Chosen: Conditional test block.** `initSchema` already wraps FTS5 creation in try-catch. Tests will detect FTS5 availability at suite startup and use `describe.skipIf(!hasFts5)` for search tests.

```javascript
const hasFts5 = (() => {
  const testDb = new Database(":memory:");
  try { testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)"); return true; }
  catch { return false; }
  finally { testDb.close(); }
})();
```

### Decision 4: Vitest config

**Chosen: Root-level `vitest.config.js` with workspace-aware test paths.** Single config, `npm test` at root runs everything. Each server's `package.json` gets `"test": "vitest run"` scoped to its directory.

No vitest.config.js needed — Vitest auto-discovers `*.test.js` files. Root `package.json` just needs `"test": "vitest run"`.

## Implementation Plan

### Task 1 — Install Vitest and configure test scripts (P1)
Add vitest as root devDependency. Add `"test": "vitest run"` to root and each server's `package.json`. Migrate `shared/db.test.js` to vitest format (replace manual assert with `expect`, `describe`/`it` blocks). Verify `npm test` runs the shared test.

### Task 2 — Extract taskboard handlers and add tests (P2)
Create `servers/taskboard/handlers.js` with all 19 handler functions extracted. Refactor `index.js` to import and delegate. Create `servers/taskboard/index.test.js` with minimum 15 test cases:
- `create_task`: happy path, missing project (no parent), default status
- `update_task`: optimistic lock success + rejection
- `add_dependency` / `remove_dependency`: BFS cycle detection (A→B→C→A), self-reference
- `set_criteria` / `check_criterion`: set, check, uncheck, invalid ID
- `search_tasks`: FTS5 match + empty results (skip if no FTS5)
- `delete_task`: cascade (comments, deps, subtasks)
- Subtask depth guard (max depth 1)
- `submit_review`: approve + reject with categories

### Task 3 — Extract memory handlers and add tests (P3)
Create `servers/memory/handlers.js` with 5 handler functions. Refactor `index.js`. Create `servers/memory/index.test.js` with minimum 8 test cases:
- `store_memory` / `recall`: round-trip with tags + importance
- `recall`: tag search with special chars (%, _, quotes)
- `recall`: agent isolation (agent A vs agent B)
- `update_memory`: change content, importance, tags
- `forget`: delete + verify gone

### Task 4 — Extract planner handlers and add tests (P4)
Create `servers/planner/handlers.js` with 6 handler functions. Refactor `index.js`. Create `servers/planner/index.test.js` with minimum 8 test cases:
- `create_plan` / `get_plan`: round-trip, step order preserved
- `update_step`: mark done/skipped, auto-completion trigger
- `create_plan` superseding: new plan supersedes active
- `complete_plan` / `abandon_plan`: status transitions, notes
- `list_plans`: filter by status, limit

### Task 5 — Integration verification and cleanup (P5)
Run full `npm test` from root. Verify all 31+ tests pass. Verify each server's `npm test` works independently. Verify CI-ready exit codes (non-zero on failure). Remove old standalone test runner comment from `shared/db.test.js`. Push to feature branch and open PR.

## Data Model

No schema changes. Tests use in-memory SQLite with identical schema to production (via `initSchema()`).

## Dependencies

| Dependency | Purpose | Install Location |
|---|---|---|
| `vitest` | Test framework | Root devDependency |

No other dependencies needed. `better-sqlite3` already available in each server's deps.

## Risks

1. **Handler extraction may reveal hidden coupling.** Some handlers may reference module-level constants (e.g., `FORGE_STATUSES`, `OPS_STATUSES`, `MEMORY_TYPES`) that aren't in `shared/db.js`. Mitigation: export these constants from the handler module or co-locate them.

2. **FTS5 availability varies by platform.** The `better-sqlite3` npm package bundles its own SQLite build — FTS5 is typically included but not guaranteed on all architectures. Mitigation: conditional skip as designed above.

3. **Refactoring 1200+ lines of taskboard handlers is error-prone.** The extraction is mechanical but tedious — 19 handlers across 1000+ lines. Mitigation: run existing functionality tests after extraction to verify no behavioral change. The `npm test` suite itself serves as the regression check.

4. **`uuid8()` and `now()` are non-deterministic.** Tests that assert on exact IDs or timestamps will be flaky. Mitigation: tests should assert on structure (ID is 8 hex chars, timestamp is ISO format) not exact values. Or use patterns like `expect(result).toContain(taskId)` where taskId was returned from creation.
