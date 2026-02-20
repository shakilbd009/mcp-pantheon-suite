# Spec: Integration Test Framework for MCP Tool Handlers

## Overview

Add integration tests that verify MCP servers work end-to-end through the JSON-RPC transport layer. Unlike unit tests (58b0e20e) which test extracted handler functions directly, these tests spawn each MCP server as a subprocess, send JSON-RPC messages via stdin, and verify stdout responses. This validates tool registration, schema validation, and the full request/response cycle.

Approach chosen: subprocess spawning with stdin/stdout pipes over MCP SDK test utilities (too tightly coupled to SDK internals) or HTTP-based testing (MCP uses stdio, not HTTP). See deliberation on task.

## User Stories

- As a contributor, I want integration tests that verify MCP tools work through the actual protocol, not just the handler logic
- As a maintainer, I want to catch regressions in tool registration, parameter schemas, or MCP SDK integration that unit tests miss

## Requirements

### Functional

1. **Test harness:** Create `tests/integration/harness.js` that:
   - Spawns an MCP server as a child process (`node servers/<name>/index.js`)
   - Sets `MCP_DB_PATH` to a temp SQLite file and `MCP_AGENT_NAME` to `test-agent`
   - Sends JSON-RPC messages to stdin and reads JSON-RPC responses from stdout
   - Handles the MCP initialization handshake (`initialize` + `initialized` notification)
   - Provides a `callTool(name, params)` helper that returns the tool result
   - Cleans up the child process and temp DB on teardown

2. **Taskboard integration tests** (`tests/integration/taskboard.test.js`, minimum 3 cases):
   - Tool discovery: call `tools/list`, verify all 19 tools are registered with correct names
   - Round-trip: `create_task` → `get_task` → verify returned data matches input
   - Error handling: call `update_task` with non-existent task ID, verify error response

3. **Memory integration tests** (`tests/integration/memory.test.js`, minimum 3 cases):
   - Tool discovery: call `tools/list`, verify all 5 tools registered
   - Round-trip: `store_memory` → `recall` with matching tag → verify memory returned
   - Agent isolation: store as agent-A, recall as agent-B (different `MCP_AGENT_NAME`), verify empty

4. **Planner integration tests** (`tests/integration/planner.test.js`, minimum 3 cases):
   - Tool discovery: call `tools/list`, verify all 6 tools registered
   - Round-trip: `create_plan` → `get_plan` → verify steps match
   - Auto-completion: create plan, mark all steps done via `update_step`, verify plan status becomes `completed`

5. **Vitest configuration:** Integration tests run separately from unit tests. Add script: `"test:integration": "vitest run tests/integration/"` to root `package.json`. Regular `npm test` should NOT include integration tests (they're slower due to subprocess spawning).

### Non-Functional

- Each test must complete in under 5 seconds (subprocess spawn + JSON-RPC round-trip)
- Tests must be deterministic — each test gets a fresh temp DB
- No MCP SDK test utilities as dependencies — use raw JSON-RPC over stdio

## Edge Cases

1. **Server startup failure:** If the subprocess fails to start (missing dependency, syntax error), the test should fail with a clear error, not hang
2. **Stdin/stdout buffering:** JSON-RPC messages must be newline-delimited. Handle partial reads by buffering until complete JSON is received
3. **Initialization timeout:** If the MCP handshake doesn't complete within 3 seconds, fail the test

## Non-Goals

- Testing MCP SDK internals or protocol compliance
- Performance benchmarking of MCP transport overhead
- Testing with real daemon or agent configs
- Replacing unit tests — integration tests complement, not replace

## Success Criteria

1. `npm run test:integration` passes with 0 failures
2. Each server has 3+ integration test cases covering tool discovery, round-trip, and error handling
3. Tests use subprocess spawning — no import of server internals
4. Integration tests run separately from unit tests (different npm script)
5. All temp files cleaned up after tests
