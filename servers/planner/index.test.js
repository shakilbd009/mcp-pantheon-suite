/**
 * Tests for planner handlers.
 * Each test gets a fresh :memory: SQLite DB via beforeEach.
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initSchema,
  createPlan,
  updateStep,
  getPlan,
  listPlans,
  completePlan,
  abandonPlan,
  computeProgress,
  formatPlan,
} from "./handlers.js";

let db;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

// Helper: create a plan and return its ID
function quickPlan(agentName, overrides = {}) {
  const params = {
    title: "Test Plan",
    steps: ["Step one", "Step two", "Step three"],
    ...overrides,
  };
  const result = createPlan(db, agentName, params);
  const match = result.content[0].text.match(/Plan created: ([0-9a-f]{8})/);
  return match ? match[1] : null;
}

// ── createPlan ──────────────────────────────────────────────────────

describe("createPlan", () => {
  it("creates a plan with steps", () => {
    const id = quickPlan("alice");
    expect(id).toBeTruthy();

    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
    expect(row.title).toBe("Test Plan");
    expect(row.status).toBe("active");
    expect(row.progress).toBe("0/3");

    const steps = JSON.parse(row.steps);
    expect(steps).toHaveLength(3);
    expect(steps[0].description).toBe("Step one");
    expect(steps[0].status).toBe("pending");
  });

  it("supersedes existing active plan", () => {
    const id1 = quickPlan("alice", { title: "Plan A" });
    const id2 = quickPlan("alice", { title: "Plan B" });

    const plan1 = db.prepare("SELECT status FROM plans WHERE id = ?").get(id1);
    const plan2 = db.prepare("SELECT status FROM plans WHERE id = ?").get(id2);
    expect(plan1.status).toBe("superseded");
    expect(plan2.status).toBe("active");
  });
});

// ── updateStep ──────────────────────────────────────────────────────

describe("updateStep", () => {
  it("marks a step as done and updates progress", () => {
    const id = quickPlan("alice");
    const result = updateStep(db, "alice", { step_id: 1, status: "done" });
    expect(result.content[0].text).toContain("1/3");

    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
    const steps = JSON.parse(row.steps);
    expect(steps[0].status).toBe("done");
    expect(steps[0].completed_at).toBeTruthy();
    expect(row.progress).toBe("1/3");
  });

  it("returns error for missing step", () => {
    quickPlan("alice");
    const result = updateStep(db, "alice", { step_id: 99, status: "done" });
    expect(result.content[0].text).toContain("Step 99 not found");
  });

  it("auto-completes plan when all steps done", () => {
    const id = quickPlan("alice", { steps: ["A", "B"] });

    updateStep(db, "alice", { step_id: 1, status: "done" });
    const result = updateStep(db, "alice", { step_id: 2, status: "done" });
    expect(result.content[0].text).toContain("All steps complete");

    const row = db.prepare("SELECT status FROM plans WHERE id = ?").get(id);
    expect(row.status).toBe("completed");
  });

  it("adds notes to a step", () => {
    const id = quickPlan("alice");
    updateStep(db, "alice", { step_id: 1, status: "in_progress", notes: "Working on it" });

    const row = db.prepare("SELECT steps FROM plans WHERE id = ?").get(id);
    const steps = JSON.parse(row.steps);
    expect(steps[0].notes).toBe("Working on it");
  });
});

// ── getPlan ─────────────────────────────────────────────────────────

describe("getPlan", () => {
  it("returns the active plan", () => {
    quickPlan("alice", { title: "My Active Plan" });
    const result = getPlan(db, "alice", {});
    expect(result.content[0].text).toContain("My Active Plan");
    expect(result.content[0].text).toContain("[active]");
  });

  it("returns 'no active plan' when none exists", () => {
    const result = getPlan(db, "alice", {});
    expect(result.content[0].text).toContain("No active plan found");
  });
});

// ── listPlans ───────────────────────────────────────────────────────

describe("listPlans", () => {
  it("lists plans filtered by status", () => {
    quickPlan("alice", { title: "Plan A" });
    quickPlan("alice", { title: "Plan B" }); // supersedes A

    const all = listPlans(db, "alice", { status: "all" });
    expect(all.content[0].text).toContain("Plan A");
    expect(all.content[0].text).toContain("Plan B");

    const active = listPlans(db, "alice", { status: "active" });
    expect(active.content[0].text).toContain("Plan B");
    expect(active.content[0].text).not.toContain("Plan A");

    const superseded = listPlans(db, "alice", { status: "superseded" });
    expect(superseded.content[0].text).toContain("Plan A");
    expect(superseded.content[0].text).not.toContain("Plan B");
  });
});

// ── completePlan ────────────────────────────────────────────────────

describe("completePlan", () => {
  it("marks plan as completed with notes", () => {
    quickPlan("alice", { title: "Finish This" });
    const result = completePlan(db, "alice", { notes: "All done" });
    expect(result.content[0].text).toContain("marked as completed");
    expect(result.content[0].text).toContain("All done");
  });
});

// ── abandonPlan ─────────────────────────────────────────────────────

describe("abandonPlan", () => {
  it("marks plan as abandoned with reason appended as step", () => {
    const id = quickPlan("alice", { title: "Bad Plan" });
    const result = abandonPlan(db, "alice", { reason: "Requirements changed" });
    expect(result.content[0].text).toContain("abandoned");
    expect(result.content[0].text).toContain("Requirements changed");

    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
    expect(row.status).toBe("abandoned");
    const steps = JSON.parse(row.steps);
    expect(steps[steps.length - 1].description).toContain("[ABANDONED]");
  });
});

// ── helpers ─────────────────────────────────────────────────────────

describe("computeProgress", () => {
  it("counts done steps", () => {
    const steps = [
      { status: "done" },
      { status: "in_progress" },
      { status: "pending" },
    ];
    expect(computeProgress(steps)).toBe("1/3");
  });
});
