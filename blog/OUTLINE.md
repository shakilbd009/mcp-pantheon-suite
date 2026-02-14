# Blog Post Outline: "How I Built 13 Autonomous Agents with MCP"

## 1. Hook

**Title options:**
- "656 Job Postings Mention MCP. Here's What I Learned Building 13 Production Servers."
- "I Built an Autonomous Agent Swarm with MCP — Here Are the 3 Servers That Made It Work"

**Opening:**
- MCP adoption is exploding — 656 job postings, growing ecosystem, but few production examples
- Most MCP tutorials show toy demos. This is what production looks like.
- 13 agents, 3 MCP servers, 30 tools, running autonomously for weeks
- Open-sourcing the servers that power it

## 2. The System (Architecture Overview)

**Keep it high-level — the servers are the product, not the orchestrator.**

- 13 AI agents (Claude-based) coordinated by a Python daemon
- Agents communicate through MCP tool servers — not direct messages, not REST APIs
- Each agent gets a scoped toolset: task management, persistent memory, action planning
- The MCP protocol lets any LLM client use these same tools — not locked to our system
- ASCII diagram: daemon → agents → MCP servers → SQLite
- Why MCP over custom APIs: standard protocol, Claude Desktop compatibility, tool discovery

## 3. Server Deep-Dives

### 3a. Taskboard (19 tools, 1203 lines)

**The problem:** Multiple agents need shared state for task coordination. Who's working on what? What's blocked? What's ready for review?

**Key design decisions:**
- Dual pipeline: 9-stage dev lifecycle for software projects, 4-stage lightweight flow for ops
- BFS circular dependency detection — agents can declare "task A blocks task B" without risk of deadlocks
- FTS5 full-text search with LIKE fallback for broader matching
- Initiatives: cross-cutting goals that link tasks from different projects
- Structured reviews with approve/reject verdicts and categorized issues
- Status transition validation — can't skip stages, enforces the process

**Code snippet: Dependency cycle detection**
```javascript
// BFS from depends_on_id — if we reach task_id, it's a cycle
const queue = [depends_on_id];
const visited = new Set();
while (queue.length > 0) {
  const current = queue.shift();
  if (current === task_id) throw new Error("Circular dependency");
  if (visited.has(current)) continue;
  visited.add(current);
  // ... traverse upstream dependencies
}
```

### 3b. Memory (5 tools, 279 lines)

**The problem:** Agents forget everything between sessions. Hard-won knowledge evaporates.

**Key design decisions:**
- 5 typed memories: fact, learning, preference, observation, pattern — type discipline prevents a junk drawer
- Importance ranking (1-10) — recall returns high-importance memories first
- Tag-based retrieval — agents can search by domain ("database", "production") not just keywords
- Access tracking — automatically counts recalls and updates timestamps
- Agent-scoped — multiple agents can share a DB file without seeing each other's memories

**Code snippet: Recall with access tracking**
```javascript
// Build WHERE clause from tags, query, type
// ORDER BY importance DESC — most important memories first
// Side effect: increment access_count, update last_accessed
```

### 3c. Planner (6 tools, 354 lines)

**The problem:** Complex tasks span multiple agent sessions. Without persistent plans, agents restart from scratch each time.

**Key design decisions:**
- Auto-supersede: creating a new plan automatically supersedes the old one (one active plan per agent)
- Auto-complete: when all steps are done/skipped, plan status flips to "completed" automatically
- Step-level tracking: each step gets its own status (pending, in_progress, done, blocked, skipped) plus optional notes
- Abandonment with reason: when plans become irrelevant, the reason is preserved as audit trail

**Code snippet: Plan creation with auto-supersede**
```javascript
// Supersede any existing active plan
db.prepare("UPDATE plans SET status='superseded', updated_at=? WHERE agent_name=? AND status='active'").run(timestamp, agent);
// Create new plan with ordered steps
db.prepare("INSERT INTO plans (id, agent_name, title, steps, ...) VALUES (...)").run(...);
```

## 4. Lessons Learned

### SQLite WAL mode for multi-agent concurrent access
- WAL (Write-Ahead Logging) allows concurrent readers with a single writer
- busy_timeout prevents immediate failures on write contention
- Each server gets its own DB file — eliminates cross-server lock contention
- In practice: 13 agents hitting 3 servers simultaneously, zero data corruption in weeks of operation

### MCP tool design principles
- **Clear descriptions matter more than code** — Claude reads tool descriptions to decide when/how to use them. Vague descriptions = wrong tool calls.
- **Sensible defaults** — Every parameter should work if omitted. `limit` defaults to 20, `status` defaults to "all", agent name defaults to "default".
- **Error messages are UI** — When a tool fails, the error message is the only feedback. Make it actionable: "Circular dependency detected: A → B → C → A" not "Invalid input."
- **Zod validation** — Catch bad inputs before they hit the database. Schema validation is free documentation.

### Why stdio over HTTP for local MCP servers
- stdio is simpler: no port management, no CORS, no auth
- Process lifecycle is managed by the MCP client — server starts/stops with the client
- No network stack overhead for local-only tools
- HTTP makes sense for remote/shared servers, but for local tools, stdio wins

## 5. CTA (Call to Action)

- **Link to repo:** github.com/shakilbd009/mcp-pantheon-suite
- **Star if useful** — these servers power real production agent systems
- **Contributions welcome:** Additional servers, better docs, bug fixes
- **What's next:**
  - Scratchpad server (key-value store for real-time agent coordination)
  - Notification server (desktop alerts, urgent notifications)
  - npm packaging for `npx` installation
- **Connect:** Link to author's GitHub/LinkedIn for agent development discussions
