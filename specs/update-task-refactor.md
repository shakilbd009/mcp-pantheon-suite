# Spec: Extract update_task Helper Functions

## Overview

Refactor the `updateTask` handler in `servers/taskboard/handlers/tasks.js` by extracting 3 helper functions: status transition validation, history recording, and a done-guard check. The function is currently ~113 lines with validation, guard checks, update construction, and history recording interleaved. Extracting helpers improves testability and makes each concern independently modifiable without risk of breaking adjacent logic.

This task depends on 0d564e9f (split taskboard handlers into domain modules) completing first — the file to edit is `handlers/tasks.js` which is created by that split. See deliberation on task 3c699bca.

## User Stories

- As a developer modifying status transition rules, I want the transition logic isolated so I can change it without touching history recording
- As a test writer, I want to unit-test transition validation and history recording independently

## Requirements

### Functional

1. **Extract `validateStatusTransition(task, newStatus)`** — Returns `{ valid: true }` or `{ valid: false, error: string }`. Encapsulates:
   - Looking up allowed transitions via `getTransitions(task.project)`
   - Checking if transition is in the allowed list
   - Generating the error message with pipeline type and hint
   - Current location: lines 270-279 of tasks.js

2. **Extract `checkDoneGuard(db, taskId)`** — Returns `{ allowed: true }` or `{ allowed: false, count: number }`. Encapsulates:
   - Querying non-done children count
   - Returning whether marking done is allowed
   - Current location: lines 282-289 of tasks.js

3. **Extract `recordStatusTransition(db, taskId, fromStatus, toStatus, agentName)`** — Encapsulates:
   - Inserting auto-comment with status transition text
   - Computing duration from last history entry
   - Inserting task_history record
   - Current location: lines 337-357 of tasks.js
   - Must be called within the existing transaction (receives `db` that's already in a transaction)

4. **updateTask uses extracted helpers** — The main function calls `validateStatusTransition`, `checkDoneGuard`, and `recordStatusTransition` instead of inline logic. Net line count of updateTask should decrease by ~30 lines.

5. **All helpers are exported** — So they can be unit-tested independently.

6. **Existing behavior unchanged** — Same MCP responses, same error messages, same transaction boundaries.

### Non-Functional

- No new dependencies
- No new files — helpers live in `tasks.js` alongside `updateTask`
- Transaction boundary unchanged — `recordStatusTransition` is called within the existing `db.transaction()` block

## Edge Cases

1. **validateStatusTransition with undefined transitions map:** If `getTransitions` returns no entry for the current status, the function should allow the transition (matching current behavior where `allowed` is undefined → no restriction).
2. **recordStatusTransition with no prior history:** `lastHist` is null. Duration should be null. Current behavior preserved.
3. **checkDoneGuard on task with no children:** Returns `{ allowed: true }`. No query needed if we know there are no children, but the current approach always queries — preserve this for simplicity.

## Non-Goals

- Refactoring parent_task_id validation (lines 292-309) — this is already clear and self-contained
- Refactoring the update field building (lines 311-329) — mechanical, not worth abstracting
- Moving helpers to a separate file — keep in tasks.js to minimize import churn
- Adding event bridging (the task description mentions it but there's no event bridge in the current code)

## Success Criteria

1. `validateStatusTransition`, `checkDoneGuard`, and `recordStatusTransition` exist as exported functions in tasks.js
2. `updateTask` calls all 3 helpers instead of inline logic
3. All existing taskboard tests pass (80 tests)
4. New unit tests for each helper: at least 2 test cases per helper (valid/invalid transition, done-guard with/without children, history recording with/without prior history)
5. `updateTask` function body is < 85 lines (down from ~113)

## Delivery

- Feature branch pushed to remote
- PR opened via `gh pr create` against main
- Task updated with branch name and PR URL
