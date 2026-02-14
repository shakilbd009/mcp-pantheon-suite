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
import { createDb, getAgentName } from "../../shared/db.js";
import {
  initSchema,
  createPlan,
  updateStep,
  getPlan,
  listPlans,
  completePlan,
  abandonPlan,
} from "./handlers.js";

// ── Init ─────────────────────────────────────────────────────────────

const db = createDb("planner");
initSchema(db);

const server = new McpServer({
  name: "mcp-planner",
  version: "1.0.0",
});

// ── create_plan ──────────────────────────────────────────────

server.tool(
  "create_plan",
  "Create a new multi-step action plan. Any existing active plan is automatically superseded. Use this to break complex tasks into trackable steps that persist across sessions.",
  {
    title: z.string().max(200).describe("Plan title (e.g. 'Deploy email notification system')"),
    steps: z.array(z.string().max(500)).min(1).max(20).describe("Ordered list of step descriptions"),
  },
  async ({ title, steps }) => createPlan(db, getAgentName(), { title, steps })
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
  async ({ step_id, status, notes, plan_id }) => updateStep(db, getAgentName(), { step_id, status, notes, plan_id })
);

// ── get_plan ─────────────────────────────────────────────────

server.tool(
  "get_plan",
  "Get your current active plan, or a specific plan by ID. Shows all steps with their status.",
  {
    plan_id: z.string().optional().describe("Specific plan ID (defaults to current active plan)"),
  },
  async ({ plan_id }) => getPlan(db, getAgentName(), { plan_id })
);

// ── list_plans ───────────────────────────────────────────────

server.tool(
  "list_plans",
  "List your recent plans. Shows a summary of each plan with status and progress.",
  {
    status: z.enum(["active", "completed", "abandoned", "superseded", "all"]).default("all").describe("Filter by status"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ status, limit }) => listPlans(db, getAgentName(), { status, limit })
);

// ── complete_plan ────────────────────────────────────────────

server.tool(
  "complete_plan",
  "Mark your active plan as completed. Use when you've finished the plan (even if some steps were skipped).",
  {
    plan_id: z.string().optional().describe("Plan ID (defaults to current active plan)"),
    notes: z.string().optional().describe("Completion notes"),
  },
  async ({ plan_id, notes }) => completePlan(db, getAgentName(), { plan_id, notes })
);

// ── abandon_plan ─────────────────────────────────────────────

server.tool(
  "abandon_plan",
  "Abandon your active plan. Use when the plan is no longer relevant or a better approach was found.",
  {
    reason: z.string().describe("Why the plan is being abandoned"),
    plan_id: z.string().optional().describe("Plan ID (defaults to current active plan)"),
  },
  async ({ reason, plan_id }) => abandonPlan(db, getAgentName(), { reason, plan_id })
);

// ── Start ────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
