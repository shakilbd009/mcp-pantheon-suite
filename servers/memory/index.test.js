/**
 * Tests for memory handlers.
 * Each test gets a fresh :memory: SQLite DB via beforeEach.
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initSchema,
  storeMemory,
  recall,
  listMemories,
  forget,
  updateMemory,
} from "./handlers.js";

let db;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

// Helper: store a memory and return its ID
function quickStore(agentName, overrides = {}) {
  const params = {
    content: "Test memory content",
    memory_type: "observation",
    tags: ["test"],
    importance: 5,
    ...overrides,
  };
  const result = storeMemory(db, agentName, params);
  const match = result.content[0].text.match(/Memory stored: ([0-9a-f]{8})/);
  return match ? match[1] : null;
}

// ── store + recall round-trip ───────────────────────────────────────

describe("storeMemory + recall", () => {
  it("stores and recalls by tag", () => {
    const id = quickStore("alice", {
      content: "Deploy needs SSH key",
      tags: ["deploy", "ssh"],
      importance: 8,
    });
    expect(id).toBeTruthy();

    const result = recall(db, "alice", { tags: ["deploy"] });
    expect(result.content[0].text).toContain("Deploy needs SSH key");
    expect(result.content[0].text).toContain("importance: 8/10");
  });

  it("returns results ordered by importance", () => {
    quickStore("alice", { content: "Low priority", importance: 2, tags: ["info"] });
    quickStore("alice", { content: "High priority", importance: 9, tags: ["info"] });

    const result = recall(db, "alice", { tags: ["info"] });
    const text = result.content[0].text;
    const highIdx = text.indexOf("High priority");
    const lowIdx = text.indexOf("Low priority");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ── recall — special characters ─────────────────────────────────────

describe("recall — special characters", () => {
  it("handles tags with %, _, and quotes without SQL injection", () => {
    quickStore("alice", {
      content: "Special tag memory",
      tags: ["100%_done", "it's_ready", "under_score"],
    });

    const result = recall(db, "alice", { tags: ["100%_done"] });
    expect(result.content[0].text).toContain("Special tag memory");
  });
});

// ── recall — agent isolation ────────────────────────────────────────

describe("recall — agent isolation", () => {
  it("only returns memories for the querying agent", () => {
    quickStore("alice", { content: "Alice secret", tags: ["private"] });
    quickStore("bob", { content: "Bob secret", tags: ["private"] });

    const aliceResult = recall(db, "alice", { tags: ["private"] });
    expect(aliceResult.content[0].text).toContain("Alice secret");
    expect(aliceResult.content[0].text).not.toContain("Bob secret");

    const bobResult = recall(db, "bob", { tags: ["private"] });
    expect(bobResult.content[0].text).toContain("Bob secret");
    expect(bobResult.content[0].text).not.toContain("Alice secret");
  });
});

// ── updateMemory ────────────────────────────────────────────────────

describe("updateMemory", () => {
  it("updates content", () => {
    const id = quickStore("alice", { content: "Old content", tags: ["test"] });

    const result = updateMemory(db, "alice", { memory_id: id, content: "New content" });
    expect(result.content[0].text).toContain("updated");

    const row = db.prepare("SELECT content FROM memories WHERE id = ?").get(id);
    expect(row.content).toBe("New content");
  });

  it("updates importance and tags", () => {
    const id = quickStore("alice", { content: "Test", tags: ["old"], importance: 3 });

    updateMemory(db, "alice", {
      memory_id: id,
      importance: 9,
      tags: ["new", "updated"],
    });

    const row = db.prepare("SELECT importance, tags FROM memories WHERE id = ?").get(id);
    expect(row.importance).toBe(9);
    expect(JSON.parse(row.tags)).toEqual(["new", "updated"]);
  });
});

// ── forget ──────────────────────────────────────────────────────────

describe("forget", () => {
  it("deletes a memory and confirms it is gone", () => {
    const id = quickStore("alice", { content: "To be forgotten", tags: ["temp"] });

    const result = forget(db, "alice", { memory_id: id });
    expect(result.content[0].text).toContain("deleted");

    const recallResult = recall(db, "alice", { tags: ["temp"] });
    expect(recallResult.content[0].text).toContain("No memories found");
  });
});

// ── Batch access-count update ────────────────────────────────────────

describe("recall — batch access_count", () => {
  it("should batch-update access_count on recall", () => {
    // Store 3 memories with shared tag
    quickStore("alice", { content: "Mem 1", tags: ["batch-test"], importance: 5 });
    quickStore("alice", { content: "Mem 2", tags: ["batch-test"], importance: 5 });
    quickStore("alice", { content: "Mem 3", tags: ["batch-test"], importance: 5 });

    // First recall
    recall(db, "alice", { tags: ["batch-test"] });

    const rows1 = db.prepare(
      "SELECT id, access_count, last_accessed FROM memories WHERE agent_name = ?"
    ).all("alice");
    expect(rows1).toHaveLength(3);
    for (const r of rows1) {
      expect(r.access_count).toBe(1);
      expect(r.last_accessed).toBeTruthy();
    }

    // Second recall
    recall(db, "alice", { tags: ["batch-test"] });

    const rows2 = db.prepare(
      "SELECT id, access_count FROM memories WHERE agent_name = ?"
    ).all("alice");
    for (const r of rows2) {
      expect(r.access_count).toBe(2);
    }
  });
});

// ── Unicode ─────────────────────────────────────────────────────────

describe("unicode content", () => {
  it("preserves emoji and CJK characters", () => {
    const id = quickStore("alice", {
      content: "Deploy status: ✅ 部署成功 🚀",
      tags: ["deploy", "日本語"],
    });

    const result = recall(db, "alice", { tags: ["deploy"] });
    expect(result.content[0].text).toContain("✅ 部署成功 🚀");
  });
});
