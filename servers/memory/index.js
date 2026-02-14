#!/usr/bin/env node
/**
 * MCP Memory Server — structured long-term memory for AI agents.
 *
 * Store observations, learnings, facts, patterns, and preferences
 * that persist across sessions. Memories are tagged for retrieval
 * and ranked by importance.
 *
 * Memory types: fact, learning, preference, observation, pattern
 *
 * Tools:
 *   - store_memory: Save a new memory with tags and importance
 *   - recall: Search memories by tags, text query, and/or type
 *   - list_memories: List all your memories
 *   - forget: Delete a memory by ID
 *   - update_memory: Update an existing memory's content or importance
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDb, getAgentName, uuid8, now } from "../../shared/db.js";

// ── Schema ───────────────────────────────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation',
      tags TEXT NOT NULL DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5,
      access_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_name);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(agent_name, memory_type);
  `);
}

// ── Init ─────────────────────────────────────────────────────────────

const MEMORY_TYPES = ["fact", "learning", "preference", "observation", "pattern"];

const db = createDb("memory");
initSchema(db);

const server = new McpServer({
  name: "mcp-memory",
  version: "1.0.0",
});

// ── store_memory ─────────────────────────────────────────────

server.tool(
  "store_memory",
  `Store a new memory. Use this to remember important information across sessions.

Memory types:
- fact: Concrete information ("staging server IP is 10.0.1.5")
- learning: Something you learned from experience ("retrying after 30s fixes the flaky test")
- preference: User or system preferences ("user prefers concise reports")
- observation: Something you noticed ("email queue backs up on Mondays")
- pattern: Recurring patterns you've identified ("deploy failures correlate with high DB load")

Tips:
- Use descriptive tags for easy retrieval later
- Set higher importance (7-10) for critical operational knowledge
- Set lower importance (1-4) for nice-to-know observations`,
  {
    content: z.string().max(10000).describe("The memory content — be specific and actionable"),
    memory_type: z.enum(MEMORY_TYPES).default("observation").describe("Type of memory"),
    tags: z.array(z.string().max(50)).min(1).max(10).describe("Tags for retrieval (e.g. ['deploy', 'staging', 'error'])"),
    importance: z.number().int().min(1).max(10).default(5).describe("Importance 1-10 (10 = critical operational knowledge)"),
  },
  async ({ content, memory_type, tags, importance }) => {
    try {
      const agent = getAgentName();
      const memId = uuid8();
      const ts = now();

      db.prepare(
        `INSERT INTO memories
         (id, agent_name, content, memory_type, tags, importance, created_at, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(memId, agent, content, memory_type, JSON.stringify(tags), importance, ts, ts);

      return {
        content: [{
          type: "text",
          text: `Memory stored: ${memId}\nType: ${memory_type} | Importance: ${importance}/10\nTags: ${tags.join(", ")}\nContent: ${content}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── recall ───────────────────────────────────────────────────

server.tool(
  "recall",
  "Search your memories by tags, text query, and/or type. Returns memories ranked by importance. Use this to recall what you know about a topic before taking action.",
  {
    query: z.string().optional().describe("Text search within memory content"),
    tags: z.array(z.string()).optional().describe("Filter by any of these tags"),
    memory_type: z.enum([...MEMORY_TYPES, "any"]).default("any").describe("Filter by memory type"),
    limit: z.number().int().min(1).max(30).default(10).describe("Max results"),
  },
  async ({ query, tags, memory_type, limit }) => {
    try {
      const agent = getAgentName();

      let clauses = ["agent_name = ?"];
      let params = [agent];

      if (query) {
        clauses.push("content LIKE ?");
        params.push(`%${query}%`);
      }
      if (memory_type && memory_type !== "any") {
        clauses.push("memory_type = ?");
        params.push(memory_type);
      }
      if (tags && tags.length > 0) {
        const tagClauses = tags.map(() => "tags LIKE ?");
        clauses.push(`(${tagClauses.join(" OR ")})`);
        for (const tag of tags) {
          params.push(`%"${tag}"%`);
        }
      }

      const where = clauses.join(" AND ");
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM memories WHERE ${where}
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(...params);

      if (rows.length === 0) {
        const filterNote = query ? ` matching "${query}"` : "";
        const tagNote = tags ? ` with tags [${tags.join(", ")}]` : "";
        return { content: [{ type: "text", text: `No memories found${filterNote}${tagNote}.` }] };
      }

      // Bump access stats
      const ts = now();
      const updateStmt = db.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
      );
      for (const r of rows) {
        updateStmt.run(ts, r.id);
      }

      const lines = rows.map((r) => {
        const memTags = JSON.parse(r.tags);
        return `[${r.id}] (${r.memory_type}, importance: ${r.importance}/10) ${r.content}\n  Tags: ${memTags.join(", ")} | Created: ${r.created_at} | Accessed: ${r.access_count + 1}x`;
      });

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── list_memories ────────────────────────────────────────────

server.tool(
  "list_memories",
  "List all your memories, optionally filtered by type. Shows a summary of each memory.",
  {
    memory_type: z.enum([...MEMORY_TYPES, "any"]).default("any").describe("Filter by type"),
    limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  },
  async ({ memory_type, limit }) => {
    try {
      const agent = getAgentName();

      let rows;
      if (memory_type && memory_type !== "any") {
        rows = db.prepare(
          `SELECT * FROM memories WHERE agent_name = ? AND memory_type = ?
           ORDER BY importance DESC, created_at DESC LIMIT ?`
        ).all(agent, memory_type, limit);
      } else {
        rows = db.prepare(
          `SELECT * FROM memories WHERE agent_name = ?
           ORDER BY importance DESC, created_at DESC LIMIT ?`
        ).all(agent, limit);
      }

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }

      const lines = rows.map((r) => {
        const preview = r.content.length > 100 ? r.content.slice(0, 100) + "..." : r.content;
        const memTags = JSON.parse(r.tags);
        return `[${r.id}] ${r.memory_type} (${r.importance}/10): ${preview}  [${memTags.join(", ")}]`;
      });

      return { content: [{ type: "text", text: `${rows.length} memories:\n\n${lines.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── forget ───────────────────────────────────────────────────

server.tool(
  "forget",
  "Delete a memory by ID. Use when a memory is outdated or incorrect.",
  {
    memory_id: z.string().describe("The memory ID to delete"),
  },
  async ({ memory_id }) => {
    try {
      const result = db.prepare("DELETE FROM memories WHERE id = ?").run(memory_id);

      if (result.changes === 0) {
        return { content: [{ type: "text", text: `Memory "${memory_id}" not found.` }] };
      }

      return { content: [{ type: "text", text: `Memory "${memory_id}" deleted.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── update_memory ────────────────────────────────────────────

server.tool(
  "update_memory",
  "Update an existing memory's content, importance, or tags. Use to correct or enhance a memory.",
  {
    memory_id: z.string().describe("The memory ID to update"),
    content: z.string().max(10000).optional().describe("New content"),
    importance: z.number().int().min(1).max(10).optional().describe("New importance (1-10)"),
    tags: z.array(z.string().max(50)).optional().describe("New tags (replaces existing)"),
  },
  async ({ memory_id, content, importance, tags }) => {
    try {
      const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(memory_id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory "${memory_id}" not found.` }] };
      }

      const updates = [];
      const params = [];
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (importance !== undefined) { updates.push("importance = ?"); params.push(importance); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(JSON.stringify(tags)); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }] };
      }

      params.push(memory_id);
      db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(...params);

      return { content: [{ type: "text", text: `Memory "${memory_id}" updated.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Start ────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
