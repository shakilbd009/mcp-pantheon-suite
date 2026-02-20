# Spec: Unit Tests for MCP Pantheon Suite

## Overview

Add comprehensive unit tests to all 3 MCP servers (taskboard, memory, planner) in the mcp-pantheon-suite. Currently only `shared/db.test.js` exists (80 lines). 30 tools across 3 servers have zero test coverage. This spec defines the test framework, structure, and required coverage to create a safety net against regressions.

**Why:** This is an open-source project. Tests are table stakes for adoption, contribution, and CI/CD. Every tool handler touches shared SQLite state — silent regressions in transition logic, validation, or dependency detection would be invisible without tests.

**Approach chosen over alternatives:** Vitest over bare Node.js runner (no CI integration) and Jest (heavier, CJS-first). See deliberation on task for full rationale.

## User Stories

- As a contributor, I want to run `npm test` and see all tests pass so I can verify my changes don't break existing functionality
- As a maintainer, I want test failures to pinpoint which tool and behavior broke so I can debug quickly
- As a CI pipeline, I want a single test command that exits non-zero on failure so I can gate merges

## Requirements

### Functional

1. **Test framework:** Vitest installed as a dev dependency at root level. `npm test` in root runs all server tests. Each server also supports `npm test` independently via workspace scripts.

2. **Test file structure:** Each server gets its own test file:
   - `servers/taskboard/index.test.js`
   - `servers/memory/index.test.js`
   - `servers/planner/index.test.js`

3. **Test harness:** Each test file creates an in-memory SQLite database (`:memory:`) with the same schema as production. Tests import and call the tool handler logic directly — they do NOT need to spin up a full MCP server. If the current code structure makes direct handler testing difficult, a thin test wrapper that calls handlers with mock request/response is acceptable.

4. **Taskboard tests (19 tools) — minimum required cases:**
   - `create_task`: happy path, missing required fields, default status assignment
   - `update_task` with `expected_status`: optimistic lock success and rejection
   - `add_dependency` / `remove_dependency`: BFS cycle detection with 3+ node chain, self-reference rejection
   - `set_criteria` / `check_criterion`: set, check, uncheck, invalid criterion ID
   - `search_tasks`: FTS5 search returns matches, empty results for no-match
   - `delete_task`: cascading deletion of comments, dependencies, subtasks
   - Status transition: verify subtask depth guard (max depth 1)
   - `submit_review`: approve and reject with categories

5. **Memory tests (5 tools) — minimum required cases:**
   - `store_memory` / `recall`: round-trip with tags, importance filtering
   - `recall`: tag-based LIKE search with special characters (%, _, quotes)
   - `recall`: agent-scoped isolation — agent A's memories not visible to agent B
   - `update_memory`: change content, importance, tags
   - `forget`: delete and verify gone from recall

6. **Planner tests (6 tools) — minimum required cases:**
   - `create_plan` / `get_plan`: round-trip, step ordering preserved
   - `update_step`: mark steps done/skipped, verify auto-completion triggers when all steps done or skipped
   - `create_plan` superseding: new plan supersedes active plan (old plan status = superseded)
   - `complete_plan` / `abandon_plan`: status transitions, notes preserved
   - `list_plans`: filtering by status, limit

7. **Shared db.js migration:** Migrate existing `shared/db.test.js` to vitest format so all tests run under one runner. The old standalone runner can be removed.

8. **npm test script:** Root `package.json` must have `"test": "vitest run"` (single-run mode, not watch). Each server `package.json` should have `"test": "vitest run"` scoped to its directory.

### Non-Functional

- Tests must complete in under 30 seconds total (in-memory SQLite is fast)
- No external dependencies beyond vitest — no mocking libraries needed (SQLite in-memory is the mock)
- Tests must be deterministic — no timing-dependent assertions, no shared state between test cases

## Edge Cases

1. **Concurrent test isolation:** Each test case must create its own DB instance or use transactions to prevent cross-test contamination
2. **FTS5 availability:** SQLite in-memory may not have FTS5 compiled in on all platforms. If FTS5 is unavailable, search tests should skip gracefully (not fail)
3. **Empty database:** Tools should handle empty tables without crashing (list returns [], search returns [], get returns not-found error)
4. **Unicode in data:** Test at least one case with unicode characters in task titles, memory content, plan step descriptions

## Non-Goals

- **Integration tests** (testing MCP protocol transport) — that's a separate task (`27b92921`)
- **100% line coverage** — focus on business logic, not boilerplate
- **Performance benchmarks** — correctness only
- **E2E tests with real daemon** — unit tests with in-memory DB only
- **Testing the MCP SDK itself** — trust the framework, test our handlers

## Success Criteria

1. `npm test` at root passes with 0 failures
2. Each server has its own test file with tests covering all minimum required cases listed above
3. Taskboard: minimum 15 test cases covering the 8 areas specified
4. Memory: minimum 8 test cases covering the 5 areas specified
5. Planner: minimum 8 test cases covering the 5 areas specified
6. All tests use in-memory SQLite — no file system side effects
7. `shared/db.test.js` migrated to vitest
8. CI-ready: `npm test` exits non-zero on any failure
