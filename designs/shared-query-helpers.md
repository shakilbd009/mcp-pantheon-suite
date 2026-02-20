# Design: Extract Shared Query Helpers

## Overview
Extract duplicated dynamic SQL clause building and JSON parsing into `shared/query.js`. Replaces 6 inline clause-building patterns across taskboard and memory servers, plus consolidates safe JSON parsing into a reusable utility. Follows the established `shared/db.js` pattern.

## Architecture

### New Module: `shared/query.js`

Exports 3 functions:
1. `buildWhereClause(filters)` — Dynamic WHERE clause from filter array
2. `buildSetClause(updates)` — Dynamic SET clause from key-value map
3. `safeJsonParse(str, defaultValue, context)` — Parse with warning on failure

### Refactoring Targets (verified against codebase)

**WHERE clause patterns (3 locations):**
| Location | File:Line | Current Pattern |
|----------|-----------|-----------------|
| listTasks | taskboard/handlers.js:215-225 | `clauses.push("col = ?"); params.push(val)` with join |
| listInitiatives | taskboard/handlers.js:785-795 | Same pattern |
| recall | memory/handlers.js:58-78 | Same pattern + OR-grouped tag clauses |

**SET clause patterns (3 locations):**
| Location | File:Line | Current Pattern |
|----------|-----------|-----------------|
| updateTask | taskboard/handlers.js:467-488 | `Object.keys(updates).map(k => k + " = ?").join(", ")` |
| updateInitiative | taskboard/handlers.js:881-896 | `sets.push("col = ?"); params.push(val)` |
| updateMemory | memory/handlers.js:163-174 | Same push pattern |

**JSON.parse sites (addressed by 73efa391, consolidated here):**
After the JSON parsing fix task adds individual try-catch blocks, this task replaces them with `safeJsonParse` calls. If JSON fix ships first, this is a simplification. If this ships first, the utility enables cleaner JSON fix implementation.

## Technical Decisions

### DECISION: buildWhereClause API — filter array vs object map
**Chosen:** Filter array of `{ column, value, op? }` objects.

**Rationale:** The memory recall handler needs OR-grouped tag clauses (`(tags LIKE ? OR tags LIKE ?)`). A simple `{ key: value }` map can't express this. An array of filter objects supports:
- Simple equality: `{ column: "status", value: "active" }`
- Custom operators: `{ column: "content", value: "%search%", op: "LIKE" }`
- Grouped OR: handled by the caller adding a raw clause (see below)

However, looking at the actual code, the tag OR-grouping in recall is complex enough that it should stay inline. The helper handles the simple equality cases; tag filtering remains in the handler.

**Simplified API:**
```javascript
// Input: array of { column, value, op? } where op defaults to "="
buildWhereClause([
  { column: "project", value: "forge/app" },
  { column: "status", value: "active" },
]);
// Output: { sql: "project = ? AND status = ?", params: ["forge/app", "active"] }
```

**Rejected:** Object map `{ status: "active" }` — can't express LIKE operators or OR groups.

### DECISION: buildSetClause API — object map
**Chosen:** Simple `{ column: value }` map. SET clauses don't need operators.

```javascript
buildSetClause({ status: "done", updated_at: "2026-02-14" });
// Output: { sql: "status = ?, updated_at = ?", params: ["done", "2026-02-14"] }
```

### DECISION: safeJsonParse behavior
**Chosen:** Returns `defaultValue` on failure + logs to stderr with `context`. Also validates expected type (array check if defaultValue is an array).

**Rationale:** Consistent with the JSON parsing fix design (73efa391). Display-only fields use this utility. Critical fields that need `isError` responses still use explicit try-catch.

### DECISION: Memory recall tag filtering — use helper or keep inline?
**Chosen:** Keep tag filtering inline in the recall handler. Use `buildWhereClause` only for the simple equality filters (agent_name, memory_type, content LIKE).

**Rationale:** Tag filtering builds OR-grouped sub-clauses (`(tags LIKE ? OR tags LIKE ?)`). Adding OR-group support to the helper over-engineers it for one call site. The simple filters are the common pattern across 3 locations.

## Considered Alternatives

**Alternative: Per-server local helpers.** Rejected — the duplication exists across servers. Local helpers don't reduce total code.

**Alternative: Use a query builder library (knex, etc).** Rejected — adds a dependency for string concatenation. These are 10-line utility functions, not ORM operations.

**Alternative: Put safeJsonParse in shared/db.js.** Rejected — it's not a DB utility, it's a data parsing utility. Separate concerns.

## Implementation Plan

### Task 1 (P1): Create shared/query.js with unit tests
- Create `shared/query.js` with `buildWhereClause`, `buildSetClause`, `safeJsonParse`
- Create `shared/query.test.js` with tests:
  - buildWhereClause: empty input → `{ sql: "", params: [] }`, single filter, multiple filters, LIKE operator, verify parameterization
  - buildSetClause: empty input → `{ sql: "", params: [] }`, single field, multiple fields
  - safeJsonParse: valid JSON, invalid JSON returns default, null/undefined returns default, non-array when default is array returns default, logs warning to stderr
  - Minimum 12 test cases
- `npm test` passes including new tests

### Task 2 (P2): Refactor taskboard WHERE/SET patterns (4 locations)
- `listTasks` (handlers.js:215-225): Replace inline clause building with `buildWhereClause`. Keep the "all" status exclusion and limit append as-is.
- `listInitiatives` (handlers.js:785-795): Same refactor.
- `updateTask` (handlers.js:467-488): Replace `Object.keys(updates).map(...)` with `buildSetClause(updates)`. Append `updated_at` before calling.
- `updateInitiative` (handlers.js:881-896): Replace inline push pattern with `buildSetClause`. Pre-stringify participants/criteria before passing.

Import `{ buildWhereClause, buildSetClause }` from `../../shared/query.js` at top of handlers.js.

### Task 3 (P3): Refactor memory WHERE/SET patterns (2 locations)
- `recall` (handlers.js:58-78): Use `buildWhereClause` for agent_name, content LIKE, memory_type filters. Keep tag OR-grouping inline (append to the returned clause manually).
- `updateMemory` (handlers.js:163-174): Replace inline push pattern with `buildSetClause`.

Import from `../../shared/query.js`.

### Task 4 (P4): Replace JSON.parse catch blocks with safeJsonParse (5+ locations)
- Replace all display-only JSON.parse catch blocks in taskboard and memory with `safeJsonParse` calls:
  - taskboard/handlers.js: categories (341), participating_agents (806, 825)
  - memory/handlers.js: tags in recall (101) and listMemories (132)
- Import `{ safeJsonParse }` from `../../shared/query.js`
- Note: `isError` sites (criteria, success_criteria, planner steps) keep explicit try-catch per the JSON fix design

## Dependencies
- None new. Pure JavaScript utility functions.
- Existing `shared/db.js` establishes the shared module pattern.

## Risks
1. **Import path changes** — Adding a new import to handlers.js files. Mechanical change but verify all servers still start.
2. **Behavioral equivalence** — The helpers must produce exactly the same SQL as the inline code. Test by running existing test suites after refactor.
3. **Tag filtering edge case** — The recall handler's tag filtering is complex. Keeping it inline is the safe choice. If someone later moves it into the helper without understanding the OR grouping, it could break.
