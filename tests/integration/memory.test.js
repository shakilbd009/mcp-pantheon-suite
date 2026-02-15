/**
 * Integration tests for the memory MCP server.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn } from "./harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory integration", () => {
  let harness;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("lists all 5 memory tools", async () => {
    harness = await spawn("servers/memory/index.js");
    const tools = await harness.listTools();

    const expected = ["store_memory", "recall", "list_memories", "forget", "update_memory"];
    for (const name of expected) {
      expect(tools, `missing tool: ${name}`).toContain(name);
    }
    expect(tools.length).toBe(5);
  });

  it("store and recall round-trip", async () => {
    const storeResult = await harness.callTool("store_memory", {
      content: "Memory integration test fact",
      tags: ["integration", "memory"],
      memory_type: "fact",
      importance: 8,
    });
    expect(storeResult.content[0].text).toContain("Memory stored");

    const recallResult = await harness.callTool("recall", {
      tags: ["integration"],
    });
    expect(recallResult.content[0].text).toContain("Memory integration test fact");
  });

  it("enforces agent isolation across separate server instances", async () => {
    // Use a shared temp DB for both harness instances
    const sharedDir = mkdtempSync(join(tmpdir(), "mcp-isolation-"));
    const sharedDb = join(sharedDir, "shared.db");

    // Agent A stores a memory
    const harnessA = await spawn("servers/memory/index.js", {
      agentName: "agent-a",
      dbPath: sharedDb,
    });

    await harnessA.callTool("store_memory", {
      content: "Secret from agent A",
      tags: ["secret"],
      memory_type: "fact",
      importance: 5,
    });
    await harnessA.close();

    // Agent B tries to recall from same DB
    const harnessB = await spawn("servers/memory/index.js", {
      agentName: "agent-b",
      dbPath: sharedDb,
    });

    const recallResult = await harnessB.callTool("recall", {
      tags: ["secret"],
    });

    // Agent B should not see agent A's memories
    expect(recallResult.content[0].text).not.toContain("Secret from agent A");
    await harnessB.close();

    // Clean up shared dir
    try { rmSync(sharedDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
