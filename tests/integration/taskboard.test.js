/**
 * Integration tests for the taskboard MCP server.
 * Spawns the server as a subprocess and communicates via JSON-RPC.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "./harness.js";

describe("taskboard integration", () => {
  let harness;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it("spawns taskboard server and lists all 19 tools", async () => {
    harness = await spawn("servers/taskboard/index.js");
    const tools = await harness.listTools();

    const expected = [
      "create_task", "list_tasks", "search_tasks", "get_task", "update_task",
      "add_comment", "submit_review", "set_criteria", "check_criterion",
      "get_board", "add_dependency", "remove_dependency", "delete_task",
      "create_initiative", "list_initiatives", "get_initiative",
      "update_initiative", "link_task_to_initiative", "add_initiative_update",
    ];

    for (const name of expected) {
      expect(tools, `missing tool: ${name}`).toContain(name);
    }
    expect(tools.length).toBe(19);
  });

  it("create_task and get_task round-trip", async () => {
    const createResult = await harness.callTool("create_task", {
      title: "Integration test task",
      project: "test/project",
    });

    expect(createResult.content).toBeDefined();
    const createText = createResult.content[0].text;
    expect(createText).toContain("Integration test task");

    // Extract task ID from response (format: "Task created: <id>")
    const idMatch = createText.match(/Task created:\s*(\S+)/);
    expect(idMatch, "could not parse task ID from create response").toBeTruthy();
    const taskId = idMatch[1];

    const getResult = await harness.callTool("get_task", { task_id: taskId });
    const getText = getResult.content[0].text;
    expect(getText).toContain("Integration test task");
    expect(getText).toContain("test/project");
  });

  it("returns error for nonexistent task", async () => {
    const result = await harness.callTool("update_task", {
      task_id: "nonexistent-id",
    });

    expect(result.content).toBeDefined();
    const text = result.content[0].text.toLowerCase();
    expect(
      result.isError || text.includes("error") || text.includes("not found"),
      "expected error or not-found message"
    ).toBe(true);
  });
});
