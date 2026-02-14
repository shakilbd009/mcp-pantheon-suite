/**
 * Tests for shared/db.js
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Set MCP_DB_PATH to a temp location before importing db.js
const tempDir = mkdtempSync(join(tmpdir(), "mcp-suite-test-"));
const testDbPath = join(tempDir, "subdir", "test.db");
process.env.MCP_DB_PATH = testDbPath;
process.env.MCP_AGENT_NAME = "test-agent";

const { createDb, getAgentName, uuid8, now } = await import("./db.js");

let db;

beforeAll(() => {
  db = createDb("test-server");
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createDb", () => {
  it("returns a database instance", () => {
    expect(db).not.toBeNull();
  });

  it("creates DB file at MCP_DB_PATH", () => {
    expect(existsSync(testDbPath)).toBe(true);
  });

  it("auto-creates parent directory", () => {
    expect(existsSync(join(tempDir, "subdir"))).toBe(true);
  });

  it("sets WAL mode", () => {
    const walMode = db.pragma("journal_mode", { simple: true });
    expect(walMode).toBe("wal");
  });

  it("returns same instance on second call (singleton)", () => {
    const db2 = createDb("different-name");
    expect(db2).toBe(db);
  });
});

describe("getAgentName", () => {
  it("reads MCP_AGENT_NAME env var", () => {
    expect(getAgentName()).toBe("test-agent");
  });
});

describe("uuid8", () => {
  it("returns 8-char string", () => {
    const id = uuid8();
    expect(id).toHaveLength(8);
  });

  it("generates unique values", () => {
    const id1 = uuid8();
    const id2 = uuid8();
    expect(id1).not.toBe(id2);
  });

  it("returns hex format", () => {
    const id = uuid8();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("now", () => {
  it("returns ISO format", () => {
    const ts = now();
    expect(ts).toContain("T");
  });

  it("ends with Z (UTC)", () => {
    const ts = now();
    expect(ts).toMatch(/Z$/);
  });

  it("parses as valid Date", () => {
    const ts = now();
    const parsed = new Date(ts);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

describe("DB functionality", () => {
  it("can create table, insert, and query", () => {
    db.exec("CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO test_table VALUES (?, ?)").run("k1", "v1");
    const row = db.prepare("SELECT * FROM test_table WHERE id = ?").get("k1");
    expect(row).toBeTruthy();
    expect(row.value).toBe("v1");
  });
});
