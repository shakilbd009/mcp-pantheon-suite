# Spec: Fix Unsafe JSON Parsing — Fail Loudly on Corruption

## Overview

Multiple locations across all 3 MCP servers use `JSON.parse()` unsafely — either with empty catch blocks that silently discard data, or with no try-catch at all (causing full server crashes). This spec requires all JSON.parse calls to handle corruption by returning descriptive `isError: true` MCP responses instead of silently losing data or crashing.

**Approach:** Fail loudly with `isError: true` responses naming the corrupted record. Silent defaults are worse than errors — they hide data loss. See deliberation on task for rationale.

## User Stories

- As an agent, I want to see an error message when my stored data is corrupted so I can take corrective action instead of silently losing information
- As a maintainer, I want JSON parse failures to be visible in tool responses so I can identify and fix data corruption

## Requirements

### Functional

1. **Taskboard — silent-loss sites (2 locations):**
   - `index.js:413` — `criteriaItems = JSON.parse(task.criteria || "[]")` with empty catch: Replace empty catch with `isError: true` response that names the task ID and field (`criteria`) that failed to parse. Example: `"Data corruption: task <id> has invalid JSON in criteria field"`
   - `index.js:1039-1040` — participants/criteria inline try-catch with silent fallback: Same treatment — return error response naming the initiative ID and corrupted field.

2. **Taskboard — already-safe sites (3 locations):**
   - `index.js:745-748` — multi-line try-catch: Verify this already returns a meaningful error. If it silently defaults, fix it.
   - `index.js:1013` — agents parse: Verify error handling. If it defaults to `[]` silently, add a warning in the response text (not a hard error, since empty agents is recoverable).

3. **Memory — crash sites (2 locations):**
   - `index.js:161` — `JSON.parse(r.tags)` in `recall` results map: Wrap in try-catch. On failure, include the memory in results but replace tags with `["CORRUPTED"]` and append a warning line to the response text: `"Warning: memory <id> has corrupted tags — showing without tag data"`
   - `index.js:204` — `JSON.parse(r.tags)` in `list_memories` results map: Same treatment as above.

4. **Planner — crash sites (3 locations):**
   - `index.js:153` — `JSON.parse(plan.steps)` in `update_step`: Wrap in try-catch. Return `isError: true` with: `"Data corruption: plan <id> has invalid JSON in steps field. Plan cannot be updated."`
   - `index.js:214` — `JSON.parse(plan.steps)` in `get_plan`: Same error response pattern.
   - `index.js:331` — `JSON.parse(plan.steps)` in `abandon_plan`: Return error but still allow the abandon to proceed (set status to abandoned) since the plan is being discarded anyway. Include warning in response.

5. **Consistent error format:** All corruption errors must use the MCP `isError: true` response format:
   ```javascript
   return { content: [{ type: "text", text: "Data corruption: ..." }], isError: true };
   ```

6. **No silent defaults:** After this fix, zero JSON.parse calls should have empty catch blocks or catch blocks that silently return default values without any indication to the caller.

### Non-Functional

- No performance impact — try-catch in JavaScript has negligible overhead on the happy path
- Error messages must include the record ID and field name to enable debugging

## Edge Cases

1. **Null vs undefined vs empty string:** `JSON.parse(null)` and `JSON.parse(undefined)` throw — handle these the same as corruption (they indicate a missing field, not valid data)
2. **Partial JSON corruption:** `JSON.parse('["a", "b"')` (truncated) — should trigger the error path like any other parse failure
3. **Valid but unexpected type:** `JSON.parse('"hello"')` returns a string, not an array — for fields expected to be arrays (criteria, tags, steps, participants), validate the parsed type is Array. If not, treat as corruption.

## Non-Goals

- **Fixing the corrupted data** — this spec makes corruption visible, not auto-repaired
- **Adding JSON schema validation** — type check (is it an array?) is sufficient
- **Database-level JSON constraints** — SQLite doesn't enforce column types
- **Logging to a separate error tracking system** — MCP response is the notification channel

## Success Criteria

1. Zero empty catch blocks around JSON.parse in any server
2. All 10 JSON.parse call sites have explicit error handling with descriptive messages
3. Memory server: corrupted tags don't crash `recall` or `list_memories`
4. Planner server: corrupted steps don't crash `update_step`, `get_plan`, or `abandon_plan`
5. Taskboard server: corrupted criteria/participants return error responses instead of empty defaults
6. Every error message includes the record ID and field name
7. Type validation: parsed JSON that isn't the expected type (e.g., string instead of array) is caught
