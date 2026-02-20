# Design: Integration Test Framework for MCP Tool Handlers

## Overview

Add end-to-end integration tests that verify MCP servers work through the actual JSON-RPC transport layer. Unlike unit tests (which test extracted handler functions directly), these tests spawn each MCP server as a subprocess, send JSON-RPC messages via stdin, and verify stdout responses. This catches regressions in tool registration, Zod schema validation, and the MCP SDK request/response cycle that unit tests cannot.

## Architecture

```
tests/integration/
├── harness.js              ← Subprocess spawn + JSON-RPC client
├── taskboard.test.js       ← 3+ tests for taskboard server
├── memory.test.js          ← 3+ tests for memory server
└── planner.test.js         ← 3+ tests for planner server
```

**Data flow per test:**
1. `harness.spawn(serverPath)` → starts `node servers/<name>/index.js` as child process
2. Harness sends MCP `initialize` request via stdin → reads `initialize` response from stdout
3. Harness sends `notifications/initialized` notification
4. Test calls `harness.callTool(name, params)` → sends `tools/call` JSON-RPC → reads response
5. `afterAll` → kills child process, deletes temp DB

**Key insight:** MCP uses [JSON-RPC 2.0 over stdio](https://spec.modelcontextprotocol.io/specification/basic/transports/#stdio). Messages are newline-delimited JSON. The SDK's `StdioServerTransport` reads line-by-line from stdin and writes line-by-line to stdout.

## Technical Decisions

### 1. Subprocess spawning via `child_process.spawn`
Each test suite spawns the server as a real child process. This tests the full boot path: module loading, schema init, DB creation, tool registration, and transport binding — not just handler logic.

### 2. Raw JSON-RPC over pipes (no MCP SDK client dependency)
The harness sends raw JSON-RPC messages to stdin and parses responses from stdout. This avoids coupling tests to MCP SDK internals and keeps the test dependency footprint at zero (beyond vitest).

### 3. Temp DB per test suite via `mkdtempSync`
Each test file gets a fresh temp directory with its own SQLite file. Set via `MCP_DB_PATH` env var. Cleaned up in `afterAll`. This matches the pattern established in `shared/db.test.js`.

### 4. Separate vitest script (`test:integration`)
Integration tests are slower (subprocess spawn overhead ~200-500ms per suite). Keep them separate from `npm test` so unit tests stay fast. Add `"test:integration": "vitest run tests/integration/"` to root package.json.

## Considered Alternatives

**Decision 1: Subprocess spawning vs. MCP SDK test client**
Chose subprocess spawning over importing and instantiating servers programmatically. The SDK provides `InMemoryTransport` for testing, but using it would bypass the actual stdio transport, `StdioServerTransport` initialization, and the server's boot path. The whole point of integration tests is to test the real startup and transport. SDK test utilities were rejected because they test a mock of the server, not the server itself.

**Decision 2: Raw JSON-RPC vs. `@modelcontextprotocol/sdk` client**
Chose raw JSON-RPC over using the SDK's client classes. Adding the SDK as a test dependency creates version coupling — if the SDK changes its client API, tests break even if the server is fine. Raw JSON-RPC is stable (it's a spec), simple, and makes the tests self-documenting. The SDK client was rejected because it hides the protocol details that integration tests should verify.

**Decision 3: One harness module vs. inline helpers per test file**
Chose a shared harness module (`harness.js`). The spawn/handshake/callTool/cleanup logic is identical across all 3 test files. Duplicating it would create maintenance burden and inconsistency. A shared module is the right abstraction here — it's used 3 times immediately and would be used by any future server tests.

## Implementation Plan

### Task 1 (P1): Create integration test harness
Build `tests/integration/harness.js` with:
- `spawn(serverPath, opts)` → starts subprocess with `MCP_DB_PATH` (temp dir) and `MCP_AGENT_NAME` env vars
- Handles MCP initialization handshake: send `initialize` request (with `protocolVersion`, `capabilities`, `clientInfo`), read response, send `initialized` notification
- `callTool(name, args)` → sends `tools/call` JSON-RPC request, reads response, returns `result.content`
- `listTools()` → sends `tools/list` request, returns tool names array
- `close()` → kills child process, cleans up temp DB directory
- Line-buffered stdout reader that accumulates data until a complete JSON line is received
- 3-second timeout on initialization, 5-second timeout on tool calls — reject promise on timeout
- Request ID counter for JSON-RPC correlation

Add `"test:integration": "vitest run tests/integration/"` to root `package.json`.

### Task 2 (P2): Write taskboard integration tests
`tests/integration/taskboard.test.js` — minimum 3 test cases:
1. **Tool discovery:** `listTools()` → verify all 19 tool names present
2. **Create-get round-trip:** `callTool("create_task", {title, project})` → extract task ID from response text → `callTool("get_task", {task_id})` → verify title and project match
3. **Error handling:** `callTool("update_task", {task_id: "nonexistent"})` → verify `isError: true` in response

### Task 3 (P2): Write memory + planner integration tests
`tests/integration/memory.test.js` — minimum 3 test cases:
1. **Tool discovery:** `listTools()` → verify 5 tools registered
2. **Store-recall round-trip:** `callTool("store_memory", {content, tags, ...})` → `callTool("recall", {tags})` → verify memory content returned
3. **Agent isolation:** Spawn with `MCP_AGENT_NAME=agent-a`, store memory → spawn new instance with `MCP_AGENT_NAME=agent-b`, recall with same tags → verify empty result

`tests/integration/planner.test.js` — minimum 3 test cases:
1. **Tool discovery:** `listTools()` → verify 6 tools registered
2. **Create-get round-trip:** `callTool("create_plan", {title, steps})` → `callTool("get_plan", {})` → verify title and step count
3. **Auto-completion:** Create plan with 2 steps → `update_step` both to `done` → `get_plan` → verify status is `completed`

## Dependencies

- **vitest** (existing) — test runner
- **Node.js `child_process`** — subprocess management (built-in)
- **Node.js `fs`, `os`, `path`** — temp directory management (built-in)
- No new dependencies

## Risks

1. **Stdin/stdout buffering:** MCP SDK's StdioServerTransport may buffer output. Mitigation: the SDK writes line-by-line (newline-delimited), so line buffering is reliable. The harness accumulates data and splits on `\n`.
2. **Subprocess startup time:** If server initialization is slow (SQLite FTS5 setup), tests may be flaky. Mitigation: 3-second handshake timeout is generous for a local process.
3. **Port/resource conflicts:** None — servers use stdio, not network ports. No shared resources between test suites.
4. **Agent isolation test requires two subprocess instances:** Spawning two servers sequentially is fine since they use separate temp DBs. The memory test creates two harness instances pointing at the same DB path but different agent names.
