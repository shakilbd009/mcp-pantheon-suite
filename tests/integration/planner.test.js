/**
 * Integration tests for the planner MCP server.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "./harness.js";

describe("planner integration", () => {
  let harness;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("lists all 6 planner tools", async () => {
    harness = await spawn("servers/planner/index.js");
    const tools = await harness.listTools();

    const expected = [
      "create_plan", "update_step", "get_plan",
      "list_plans", "complete_plan", "abandon_plan",
    ];
    for (const name of expected) {
      expect(tools, `missing tool: ${name}`).toContain(name);
    }
    expect(tools.length).toBe(6);
  });

  it("create and get plan round-trip", async () => {
    const createResult = await harness.callTool("create_plan", {
      title: "Integration test plan",
      steps: ["Step 1", "Step 2"],
    });
    expect(createResult.content[0].text).toContain("Integration test plan");

    const getResult = await harness.callTool("get_plan", {});
    const text = getResult.content[0].text;
    expect(text).toContain("Integration test plan");
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
  });

  it("auto-completes plan when all steps done", async () => {
    // Create a fresh plan (supersedes the previous one)
    await harness.callTool("create_plan", {
      title: "Auto-complete test plan",
      steps: ["First", "Second"],
    });

    await harness.callTool("update_step", { step_id: 1, status: "done" });
    const step2Result = await harness.callTool("update_step", { step_id: 2, status: "done" });

    // Auto-completion message should appear in the step update response
    expect(step2Result.content[0].text).toContain("completed");

    // get_plan with no params returns "No active plan" since it's completed
    // Use list_plans to verify the plan status
    const listResult = await harness.callTool("list_plans", { status: "completed" });
    const listText = listResult.content[0].text;
    expect(listText).toContain("Auto-complete test plan");
    expect(listText).toContain("completed");
  });
});
