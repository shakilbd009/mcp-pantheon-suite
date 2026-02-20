# Design: Batch Memory Recall Access-Count Updates

## Overview

Replace the N+1 UPDATE loop in the memory server's `recall` handler with a single batched `WHERE IN` UPDATE. This is a surgical, 5-line fix with one new test.

## Architecture

No architectural change. Single function modification in `servers/memory/handlers.js`, recall handler (lines 91-98).

**Before:** 1 SELECT + N individual UPDATEs (up to 30 statements)
**After:** 1 SELECT + 1 batched UPDATE (always 2 statements)

## Technical Decisions

### Single `WHERE IN` UPDATE
Replace the prepared-statement loop with:
```javascript
if (rows.length > 0) {
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id IN (${placeholders})`
  ).run(ts, ...ids);
}
```

The `access_count + 1` display on line 102 (`Accessed: ${r.access_count + 1}x`) remains correct — it reads from the pre-update `rows` and adds 1 for display, matching the DB state after the batch update.

## Considered Alternatives

**Decision: WHERE IN vs. transaction-wrapped loop vs. async deferred update**
Chose `WHERE IN` because it's the simplest correct solution — one statement, same semantics, ~15x fewer DB round-trips. Transaction wrapping was rejected because a single statement is already atomic; wrapping adds complexity for zero benefit. Async/deferred updates were rejected because they decouple the update from the request lifecycle, creating eventual-consistency issues for access counts that should be immediately visible.

## Implementation Plan

Single task — this is a 5-line change plus a test.

### Task 1 (P1): Batch recall UPDATE and add access-count test
In `servers/memory/handlers.js`, replace lines 91-98 (the `for` loop with individual `updateStmt.run` calls) with the batched `WHERE IN` approach. Keep the `rows.length === 0` early return on line 85 — no empty `WHERE IN ()` queries.

In `servers/memory/index.test.js`, add a test case:
- Store 3 memories with distinct tags
- Recall all 3 (matching query)
- Query DB directly: `SELECT id, access_count, last_accessed FROM memories`
- Assert all 3 have `access_count = 1` and `last_accessed` is set to a recent timestamp
- Recall again → assert `access_count = 2`

**Do NOT touch `servers/memory/index.js`** — the duplicate code there will be removed by subtask 0f9b0975 (handler extraction). Fixing dead code is wasted effort.

## Risks

1. **Parameter limit:** SQLite default max params is 999. With limit=30 results + 1 timestamp, we use 31 params max. No risk.
2. **Empty result set:** Guarded by `rows.length > 0` check. No risk of `WHERE IN ()` syntax error.
3. **Behavioral regression:** Display format is unchanged. The `access_count + 1` display math on line 102 still works because it reads from the pre-update `rows` object.
