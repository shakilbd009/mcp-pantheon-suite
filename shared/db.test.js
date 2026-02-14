/**
 * Tests for shared/db.js
 * Run: node shared/db.test.js
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set MCP_DB_PATH to a temp location before importing db.js
const tempDir = mkdtempSync(join(tmpdir(), "mcp-suite-test-"));
const testDbPath = join(tempDir, "subdir", "test.db");
process.env.MCP_DB_PATH = testDbPath;
process.env.MCP_AGENT_NAME = "test-agent";

const { createDb, getAgentName, uuid8, now } = await import("./db.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

console.log("Testing shared/db.js\n");

// Test 1: createDb creates directory and returns DB
console.log("createDb():");
const db = createDb("test-server");
assert(db !== null, "returns a database instance");
assert(existsSync(testDbPath), "creates DB file at MCP_DB_PATH");
assert(existsSync(join(tempDir, "subdir")), "auto-creates parent directory");

// Test 2: WAL mode is set
const walMode = db.pragma("journal_mode", { simple: true });
assert(walMode === "wal", `WAL mode is set (got: ${walMode})`);

// Test 3: Singleton behavior
const db2 = createDb("different-name");
assert(db === db2, "returns same instance on second call (singleton)");

// Test 4: getAgentName reads env
console.log("\ngetAgentName():");
assert(getAgentName() === "test-agent", "reads MCP_AGENT_NAME env var");

// Test 5: uuid8 format
console.log("\nuuid8():");
const id1 = uuid8();
const id2 = uuid8();
assert(id1.length === 8, `returns 8-char string (got: "${id1}")`);
assert(id1 !== id2, "generates unique values");
assert(/^[0-9a-f]{8}$/.test(id1), `hex format (got: "${id1}")`);

// Test 6: now() returns ISO string
console.log("\nnow():");
const ts = now();
assert(ts.includes("T"), `returns ISO format (got: "${ts}")`);
assert(ts.endsWith("Z"), `ends with Z (got: "${ts}")`);
const parsed = new Date(ts);
assert(!isNaN(parsed.getTime()), "parses as valid Date");

// Test 7: DB is functional — can create and query tables
console.log("\nDB functionality:");
db.exec("CREATE TABLE test_table (id TEXT PRIMARY KEY, value TEXT)");
db.prepare("INSERT INTO test_table VALUES (?, ?)").run("k1", "v1");
const row = db.prepare("SELECT * FROM test_table WHERE id = ?").get("k1");
assert(row && row.value === "v1", "can create table, insert, and query");

// Cleanup
db.close();
rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
