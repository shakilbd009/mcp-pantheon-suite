# Spec: Extract Shared Query Helpers

## Overview

Extract duplicated dynamic SQL clause building and unsafe JSON parsing into `shared/query.js`. Three servers (taskboard, memory, planner) repeat the same WHERE-clause array-push pattern (3 locations), SET-clause update pattern (3 locations), and silent-fallback JSON.parse (5 locations). A shared module reduces ~70 lines of duplication and creates a single source of truth for query construction and safe JSON parsing.

We chose a shared module because `shared/db.js` already establishes the cross-server shared utility pattern. See deliberation on task e249b3da for alternatives considered.

## User Stories

- As a maintainer, I want one WHERE-clause builder so that filter logic changes happen in one place, not three
- As a maintainer, I want one SET-clause builder so that update logic changes happen in one place, not three
- As an operator, I want JSON parse failures to be logged (not silently swallowed) so that data corruption is visible

## Requirements

### Functional

1. **Create `shared/query.js`** exporting three functions:
   - `buildWhereClause(filters)` — Takes an array of `{ column, op, value }` objects (or a simpler `{ key: value }` map for equality checks). Returns `{ sql: string, params: any[] }` where `sql` is the WHERE clause (without the `WHERE` keyword) and `params` is the parameterized values array. Returns `{ sql: "", params: [] }` for empty filters.
   - `buildSetClause(updates)` — Takes a `{ column: value }` map. Returns `{ sql: string, params: any[] }` where `sql` is comma-separated `col = ?` pairs. Returns `{ sql: "", params: [] }` for empty updates.
   - `safeJsonParse(str, defaultValue, context)` — Parses JSON string. On failure: logs a warning to stderr with `context` string describing what was being parsed, and returns `defaultValue`. On success: returns parsed result.

2. **Refactor taskboard `list_tasks`** (index.js lines 287-301): Replace inline clause-push with `buildWhereClause`. Filter map: `{ project, status (if not "all"), assigned_to }`.

3. **Refactor taskboard `list_initiatives`** (index.js lines 990-1003): Replace inline clause-push with `buildWhereClause`. Filter map: `{ status (if not "all"), owner }`.

4. **Refactor taskboard `update_task`** (index.js lines 578-602): Replace inline SET building with `buildSetClause`. Always append `updated_at = now()`.

5. **Refactor taskboard `update_initiative`** (index.js lines 1109-1127): Replace inline SET building with `buildSetClause`. JSON-serialize `participants` and `criteria` before passing. Always append `updated_at = now()`.

6. **Refactor memory `recall`** (index.js lines 118-143): Replace inline clause-push with `buildWhereClause`. Note: this has a more complex pattern with tag LIKE clauses — the helper must support OR-grouped sub-clauses for tags, OR the tag filtering can remain inline while the simpler clauses use the helper.

7. **Refactor memory `update_memory`** (index.js lines 256-267): Replace inline SET building with `buildSetClause`. JSON-serialize `tags` before passing.

8. **Replace all 5 silent JSON.parse catch blocks** with `safeJsonParse`:
   - `taskboard/index.js:413` — criteria parsing in `get_task` (default: `[]`)
   - `taskboard/index.js:746` — criteria parsing in `check_criterion` (default: `[]`)
   - `taskboard/index.js:1013` — participating_agents in `list_initiatives` (default: `[]`)
   - `taskboard/index.js:1039` — participating_agents in `get_initiative` (default: `[]`)
   - `taskboard/index.js:1040` — success_criteria in `get_initiative` (default: `[]`)

9. **Fix unprotected JSON.parse** at `memory/index.js:160` — `JSON.parse(r.tags)` has no try-catch and will crash on corrupt data. Replace with `safeJsonParse(r.tags, [], "memory tags")`.

10. **Unit tests** in `shared/query.test.js`:
    - `buildWhereClause`: empty filters, single filter, multiple filters, verify parameterization
    - `buildSetClause`: empty updates, single field, multiple fields, verify parameterization
    - `safeJsonParse`: valid JSON, invalid JSON returns default, null/undefined input returns default, logs warning on failure

### Non-Functional

- No new dependencies — pure JavaScript utility functions
- Zero behavior change for valid inputs — all existing tool responses identical
- Import path: `../shared/query.js` from server directories (consistent with existing `../shared/db.js` imports)

## Edge Cases

1. **Empty filter map to `buildWhereClause`:** Returns empty SQL and empty params — caller must handle the "no WHERE clause" case (or the function returns `"1=1"` as a safe default)
2. **`safeJsonParse` with non-string input (null, undefined, number):** Must not throw — return `defaultValue`
3. **`buildSetClause` with no fields:** Returns empty — caller should check and return "No fields to update" error before executing SQL
4. **Memory `recall` tag filtering:** Tags use `LIKE '%"tag"%'` pattern with OR grouping — this is more complex than simple equality. The helper should either support grouped OR clauses or tag filtering stays inline (implementation choice for Daedalus/Hephaestus).

## Non-Goals

- Refactoring planner server — it has minimal duplication (no dynamic WHERE/SET building)
- Adding query builder features beyond what's currently needed (no JOIN support, no ORDER BY building)
- Changing JSON storage format — we parse what's there, we don't restructure it
- Performance optimization — these are string concatenation utilities, not hot paths

## Success Criteria

1. `shared/query.js` exists with `buildWhereClause`, `buildSetClause`, `safeJsonParse` exports
2. `shared/query.test.js` passes with coverage of all 3 functions (minimum 10 test cases)
3. All 6 inline clause-building patterns replaced with shared helpers (or justified exceptions for complex patterns like tag filtering)
4. All 5 silent JSON.parse catch blocks replaced with `safeJsonParse`
5. The unprotected `JSON.parse(r.tags)` in memory server is fixed
6. `npm test` passes in the shared package
7. Existing tool behavior unchanged — verify by running the servers against a test DB

## Delivery

- Feature branch pushed to remote
- PR opened via `gh pr create` against main
- Task updated with branch name and PR URL
