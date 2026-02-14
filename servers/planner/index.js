#!/usr/bin/env node
/**
 * MCP Planner Server — structured multi-step action plans for AI agents.
 *
 * Create plans with ordered steps, track progress across sessions,
 * and complete or abandon plans. Only one active plan per agent at a time.
 *
 * Tools:
 *   - create_plan: Create a new multi-step action plan
 *   - update_step: Update a step's status (done/in_progress/blocked/skipped)
 *   - get_plan: Get current active plan or a specific plan by ID
 *   - list_plans: List recent plans
 *   - complete_plan: Mark the active plan as completed
 *   - abandon_plan: Abandon the active plan with a reason
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDb, getAgentName, uuid8, now } from "../../shared/db.js";

// ── Schema ───────────────────────────────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      title TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      progress TEXT DEFAULT '0/0',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_name);
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(agent_name, status);
  `);
}

// ── Init ─────────────────────────────────────────────────────────────

const db = createDb("planner");
initSchema(db);

const server = new McpServer({
  name: "mcp-planner",
  version: "1.0.0",
});

// ── Helpers ──────────────────────────────────────────────────────────

function computeProgress(steps) {
  const done = steps.filter((s) => s.status === "done").length;
  return `${done}/${steps.length}`;
}

function formatPlan(plan, steps) {
  const lines = [`Plan: ${plan.title} [${plan.status}] (${plan.progress})`];
  lines.push(`ID: ${plan.id} | Created: ${plan.created_at}`);
  lines.push("");
  for (const step of steps) {
    const icon =
      step.status === "done" ? "✓" :
      step.status === "in_progress" ? "▸" :
      step.status === "blocked" ? "✗" :
      step.status === "skipped" ? "–" : "○";
    let line = `  ${icon} Step ${step.id}: ${step.description} [${step.status}]`;
    if (step.notes) line += ` — ${step.notes}`;
    lines.push(line);
  }
  return lines.join("\n");
}

// ── create_plan ──────────────────────────────────────────────

server.tool(
  "create_plan",
  "Create a new multi-step action plan. Any existing active plan is automatically superseded. Use this to break complex tasks into trackable steps that persist across sessions.",
  {
    title: z.string().max(200).describe("Plan title (e.g. 'Deploy email notification system')"),
    steps: z.array(z.string().max(500)).min(1).max(20).describe("Ordered list of step descriptions"),
  },
  async ({ title, steps }) => {
    try {
      const agent = getAgentName();
      const planId = uuid8();
      const ts = now();

      // Supersede any existing active plan
      db.prepare(
        `UPDATE plans SET status = 'superseded', updated_at = ?
         WHERE agent_name = ? AND status = 'active'`
      ).run(ts, agent);

      const stepList = steps.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending",
        notes: "",
        completed_at: null,
      }));

      const progress = `0/${stepList.length}`;

      db.prepare(
        `INSERT INTO plans
         (id, agent_name, title, steps, status, progress, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(planId, agent, title, JSON.stringify(stepList), progress, ts, ts);

      return {
        content: [{
          type: "text",
          text: `Plan created: ${planId}\n\n${formatPlan({ id: planId, title, status: "active", progress, created_at: ts }, stepList)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── update_step ──────────────────────────────────────────────

server.tool(
  "update_step",
  "Update a step's status in your active plan. Use this as you make progress through your plan steps.",
  {
    step_id: z.number().int().min(1).describe("Step number to update"),
    status: z.enum(["done", "in_progress", "blocked", "skipped", "pending"]).describe("New status"),
    notes: z.string().optional().describe("Optional notes about this step"),
    plan_id: z.string().optional().describe("Plan ID (defaults to current active plan)"),
  },
  async ({ step_id, status, notes, plan_id }) => {
    try {
      const agent = getAgentName();

      let plan;
      if (plan_id) {
        plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(plan_id);
      } else {
        plan = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).get(agent);
      }

      if (!plan) {
        return { content: [{ type: "text", text: "No active plan found. Create one with create_plan first." }] };
      }

      const steps = JSON.parse(plan.steps);
      const step = steps.find((s) => s.id === step_id);
      if (!step) {
        return { content: [{ type: "text", text: `Step ${step_id} not found. Plan has ${steps.length} steps.` }] };
      }

      step.status = status;
      if (notes !== undefined) step.notes = notes;
      if (status === "done") step.completed_at = now();

      const progress = computeProgress(steps);
      const ts = now();

      // Check if all steps are done → auto-complete
      const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");

      if (allDone) {
        db.prepare(
          `UPDATE plans SET steps = ?, progress = ?, status = 'completed',
           completed_at = ?, updated_at = ? WHERE id = ?`
        ).run(JSON.stringify(steps), progress, ts, ts, plan.id);
      } else {
        db.prepare(
          "UPDATE plans SET steps = ?, progress = ?, updated_at = ? WHERE id = ?"
        ).run(JSON.stringify(steps), progress, ts, plan.id);
      }

      let msg = `Step ${step_id} → ${status} (${progress})`;
      if (allDone) msg += "\n\nAll steps complete! Plan marked as completed.";
      return { content: [{ type: "text", text: msg }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── get_plan ─────────────────────────────────────────────────

server.tool(
  "get_plan",
  "Get your current active plan, or a specific plan by ID. Shows all steps with their status.",
  {
    plan_id: z.string().optional().describe("Specific plan ID (defaults to current active plan)"),
  },
  async ({ plan_id }) => {
    try {
      const agent = getAgentName();

      let plan;
      if (plan_id) {
        plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(plan_id);
      } else {
        plan = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).get(agent);
      }

      if (!plan) {
        return { content: [{ type: "text", text: "No active plan found." }] };
      }

      const steps = JSON.parse(plan.steps);
      return { content: [{ type: "text", text: formatPlan(plan, steps) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── list_plans ───────────────────────────────────────────────

server.tool(
  "list_plans",
  "List your recent plans. Shows a summary of each plan with status and progress.",
  {
    status: z.enum(["active", "completed", "abandoned", "superseded", "all"]).default("all").describe("Filter by status"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ status, limit }) => {
    try {
      const agent = getAgentName();

      let rows;
      if (status === "all") {
        rows = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? ORDER BY updated_at DESC LIMIT ?"
        ).all(agent, limit);
      } else {
        rows = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? AND status = ? ORDER BY updated_at DESC LIMIT ?"
        ).all(agent, status, limit);
      }

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No plans found." }] };
      }

      const lines = rows.map((r) => {
        const icon =
          r.status === "active" ? "▸" :
          r.status === "completed" ? "✓" :
          r.status === "abandoned" ? "✗" : "–";
        return `${icon} [${r.id}] ${r.title} (${r.progress}) [${r.status}] — ${r.updated_at}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── complete_plan ────────────────────────────────────────────

server.tool(
  "complete_plan",
  "Mark your active plan as completed. Use when you've finished the plan (even if some steps were skipped).",
  {
    plan_id: z.string().optional().describe("Plan ID (defaults to current active plan)"),
    notes: z.string().optional().describe("Completion notes"),
  },
  async ({ plan_id, notes }) => {
    try {
      const agent = getAgentName();
      const ts = now();

      let plan;
      if (plan_id) {
        plan = db.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").get(plan_id);
      } else {
        plan = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).get(agent);
      }

      if (!plan) {
        return { content: [{ type: "text", text: "No active plan found to complete." }] };
      }

      db.prepare(
        "UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(ts, ts, plan.id);

      return { content: [{ type: "text", text: `Plan "${plan.title}" marked as completed.${notes ? " Notes: " + notes : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── abandon_plan ─────────────────────────────────────────────

server.tool(
  "abandon_plan",
  "Abandon your active plan. Use when the plan is no longer relevant or a better approach was found.",
  {
    reason: z.string().describe("Why the plan is being abandoned"),
    plan_id: z.string().optional().describe("Plan ID (defaults to current active plan)"),
  },
  async ({ reason, plan_id }) => {
    try {
      const agent = getAgentName();
      const ts = now();

      let plan;
      if (plan_id) {
        plan = db.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").get(plan_id);
      } else {
        plan = db.prepare(
          "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).get(agent);
      }

      if (!plan) {
        return { content: [{ type: "text", text: "No active plan found to abandon." }] };
      }

      // Append abandonment note as a step
      const steps = JSON.parse(plan.steps);
      steps.push({
        id: steps.length + 1,
        description: `[ABANDONED] ${reason}`,
        status: "skipped",
        notes: reason,
        completed_at: ts,
      });

      db.prepare(
        "UPDATE plans SET status = 'abandoned', steps = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(steps), ts, plan.id);

      return { content: [{ type: "text", text: `Plan "${plan.title}" abandoned. Reason: ${reason}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Start ────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
