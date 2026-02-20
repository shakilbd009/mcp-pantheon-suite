# Spec: Batch Memory Recall Access-Count Updates

## Overview

Fix N+1 query anti-pattern in the memory server's `recall` handler. Currently, each recall executes 1 SELECT + up to 30 individual UPDATEs in a loop. Replace with a single batched UPDATE using `WHERE IN`. This reduces WAL lock contention and improves recall latency by ~15x.

Approach chosen: single `WHERE IN` UPDATE over transaction wrapping (unnecessary complexity) or async deferred updates (over-engineering). See deliberation on task.

## User Stories

- As an agent recalling memories, I want fast recall responses so my sessions aren't slowed by unnecessary DB round-trips
- As a system operator, I want minimal WAL lock contention so concurrent agent recalls don't degrade each other

## Requirements

### Functional

1. **Batch UPDATE:** Replace the `for (const r of rows) { updateStmt.run(ts, r.id) }` loop in the `recall` handler with a single `UPDATE ... WHERE id IN (...)` statement. The UPDATE must set both `access_count = access_count + 1` and `last_accessed = ?` for all matched rows in one statement.

2. **Correct placeholder generation:** Build the placeholder string dynamically from the result set: `const ids = rows.map(r => r.id); const ph = ids.map(() => '?').join(',');`. Pass `[ts, ...ids]` as parameters.

3. **Empty result handling:** If `rows.length === 0`, skip the UPDATE entirely (no empty `WHERE IN ()` query).

4. **Fix location:** Apply the fix in `servers/memory/handlers.js` only. The duplicate code in `servers/memory/index.js` will be removed by subtask 0f9b0975 (handler extraction) — do not fix both.

5. **Behavioral equivalence:** The recall response format, ordering, and content must remain identical. The `access_count + 1` display in the response text must still be correct.

6. **Unit test:** Add or update a test case in `servers/memory/index.test.js` that verifies access_count increments correctly after recall. Store 3 memories, recall them, then query the DB to verify all 3 have `access_count = 1` and `last_accessed` is set.

### Non-Functional

- The batched UPDATE must execute as a single SQLite statement (no transaction wrapper needed for a single statement)
- No new dependencies

## Edge Cases

1. **Single result:** `WHERE IN (?)` with one ID must work correctly (degenerate case of batch)
2. **Maximum results (limit=30):** `WHERE IN` with 30 placeholders must not exceed SQLite's parameter limit (default 999 — well within bounds)
3. **Concurrent recall:** Two agents recalling simultaneously should both increment correctly — SQLite WAL handles this, but the reduced lock duration from batching makes contention less likely

## Non-Goals

- Fixing the duplicate code in `index.js` (handled by 0f9b0975)
- Optimizing the SELECT query itself
- Adding caching or materialized views for recall
- Changing the recall response format

## Success Criteria

1. `recall` handler uses a single UPDATE statement instead of a loop
2. All existing memory tests pass
3. New test verifies access_count increments correctly for multiple recalled memories
4. No behavioral change in recall output
