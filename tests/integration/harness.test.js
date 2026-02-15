/**
 * Smoke test for the integration test harness.
 * Verifies spawn, listTools, callTool, and close work against the memory server.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "./harness.js";

describe("integration harness", () => {
  let harness;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("spawns memory server and completes handshake", async () => {
    harness = await spawn("servers/memory/index.js");
    expect(harness.serverInfo).toBeDefined();
    expect(harness.dbPath).toContain("test.db");
  });

  it("lists tools", async () => {
    const tools = await harness.listTools();
    expect(tools).toContain("store_memory");
    expect(tools).toContain("recall");
    expect(tools).toContain("list_memories");
    expect(tools).toContain("forget");
    expect(tools).toContain("update_memory");
    expect(tools.length).toBe(5);
  });

  it("calls store_memory and recall round-trip", async () => {
    const storeResult = await harness.callTool("store_memory", {
      content: "Integration tests are working",
      tags: ["test", "harness"],
      memory_type: "fact",
      importance: 7,
    });

    expect(storeResult.content).toBeDefined();
    expect(storeResult.content[0].text).toContain("Memory stored");

    const recallResult = await harness.callTool("recall", {
      tags: ["harness"],
    });

    expect(recallResult.content).toBeDefined();
    expect(recallResult.content[0].text).toContain("Integration tests are working");
  });

  it("handles tool errors gracefully", async () => {
    const result = await harness.callTool("forget", {
      memory_id: "nonexistent-id-12345",
    });

    // Should return isError or a "not found" message, not throw
    expect(result.content).toBeDefined();
  });
});
