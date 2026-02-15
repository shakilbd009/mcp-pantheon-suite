/**
 * Planner handler functions — pure logic extracted for testability.
 * Each handler accepts (db, agentName, params) and returns MCP-compatible results.
 */
import { uuid8, now } from "../../shared/db.js";

// ── Schema ───────────────────────────────────────────────────────────

export function initSchema(db) {
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

// ── Helpers ──────────────────────────────────────────────────────────

export function computeProgress(steps) {
  const done = steps.filter((s) => s.status === "done").length;
  return `${done}/${steps.length}`;
}

export function formatPlan(plan, steps) {
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

// ── Handlers ─────────────────────────────────────────────────────────

export function createPlan(db, agentName, { title, steps }) {
  try {
    const planId = uuid8();
    const ts = now();

    // Supersede any existing active plan
    db.prepare(
      `UPDATE plans SET status = 'superseded', updated_at = ?
       WHERE agent_name = ? AND status = 'active'`
    ).run(ts, agentName);

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
    ).run(planId, agentName, title, JSON.stringify(stepList), progress, ts, ts);

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

export function updateStep(db, agentName, { step_id, status, notes, plan_id }) {
  try {
    let plan;
    if (plan_id) {
      plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(plan_id);
    } else {
      plan = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(agentName);
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

export function getPlan(db, agentName, { plan_id }) {
  try {
    let plan;
    if (plan_id) {
      plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(plan_id);
    } else {
      plan = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(agentName);
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

export function listPlans(db, agentName, { status = "all", limit = 10 }) {
  try {
    let rows;
    if (status === "all") {
      rows = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? ORDER BY updated_at DESC LIMIT ?"
      ).all(agentName, limit);
    } else {
      rows = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? AND status = ? ORDER BY updated_at DESC LIMIT ?"
      ).all(agentName, status, limit);
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

export function completePlan(db, agentName, { plan_id, notes }) {
  try {
    const ts = now();

    let plan;
    if (plan_id) {
      plan = db.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").get(plan_id);
    } else {
      plan = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(agentName);
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

export function abandonPlan(db, agentName, { reason, plan_id }) {
  try {
    const ts = now();

    let plan;
    if (plan_id) {
      plan = db.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").get(plan_id);
    } else {
      plan = db.prepare(
        "SELECT * FROM plans WHERE agent_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(agentName);
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
