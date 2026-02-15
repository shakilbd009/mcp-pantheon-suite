/**
 * Memory handler functions — pure logic extracted for testability.
 * Each handler accepts (db, agentName, params) and returns MCP-compatible results.
 */
import { uuid8, now } from "../../shared/db.js";

// ── Schema ───────────────────────────────────────────────────────────

export function initSchema(db) {
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

// ── Constants ────────────────────────────────────────────────────────

export const MEMORY_TYPES = ["fact", "learning", "preference", "observation", "pattern"];

// ── Handlers ─────────────────────────────────────────────────────────

export function storeMemory(db, agentName, { content, memory_type = "observation", tags, importance = 5 }) {
  try {
    const memId = uuid8();
    const ts = now();

    db.prepare(
      `INSERT INTO memories
       (id, agent_name, content, memory_type, tags, importance, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(memId, agentName, content, memory_type, JSON.stringify(tags), importance, ts, ts);

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

export function recall(db, agentName, { query, tags, memory_type = "any", limit = 10 }) {
  try {
    let clauses = ["agent_name = ?"];
    let params = [agentName];

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

export function listMemories(db, agentName, { memory_type = "any", limit = 20 }) {
  try {
    let rows;
    if (memory_type && memory_type !== "any") {
      rows = db.prepare(
        `SELECT * FROM memories WHERE agent_name = ? AND memory_type = ?
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(agentName, memory_type, limit);
    } else {
      rows = db.prepare(
        `SELECT * FROM memories WHERE agent_name = ?
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(agentName, limit);
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

export function forget(db, agentName, { memory_id }) {
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

export function updateMemory(db, agentName, { memory_id, content, importance, tags }) {
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
