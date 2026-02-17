/**
 * Initiative handlers — cross-cutting goals spanning multiple agents.
 */
import { uuid8, now } from "../../../shared/db.js";
import { buildWhereClause, buildSetClause, safeJsonParse } from "../../../shared/query.js";

const INITIATIVE_WHERE_COLUMNS = new Set(["status", "owner"]);
const INITIATIVE_SET_COLUMNS = new Set([
  "status", "progress_pct", "description", "title",
  "participating_agents", "success_criteria", "target_date", "updated_at",
]);

export function createInitiative(db, agentName, { title, description = "", participants = [], criteria = [], target_date }) {
  try {
    const id = uuid8();
    const ts = now();

    db.prepare(
      `INSERT INTO initiatives
       (id, title, description, owner, participating_agents, success_criteria, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, description, agentName, JSON.stringify(participants), JSON.stringify(criteria), target_date || null, ts, ts);

    return { content: [{ type: "text", text: `Initiative created: ${id} — "${title}" (owner: ${agentName}, participants: ${participants.join(", ") || "none yet"})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function listInitiatives(db, agentName, { status = "active", owner, limit = 20 }) {
  try {
    const filters = [];
    if (status && status !== "all") filters.push({ column: "status", value: status });
    if (owner) filters.push({ column: "owner", value: owner });

    const { sql: where, params } = buildWhereClause(filters, { allowedColumns: INITIATIVE_WHERE_COLUMNS });
    let sql = "SELECT * FROM initiatives";
    if (where) sql += " WHERE " + where;
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No initiatives found matching filters." }] };
    }

    const lines = rows.map((i) => {
      const pct = i.progress_pct || 0;
      const target = i.target_date ? ` (target: ${i.target_date})` : "";
      const agents = safeJsonParse(i.participating_agents, [], "initiative " + i.id + " agents");
      const agentStr = agents.length ? ` → ${agents.join(", ")}` : "";
      return `${i.id} | [${i.status}] ${pct}% | ${i.title} (owner: ${i.owner})${agentStr}${target}`;
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function getInitiative(db, agentName, { initiative_id }) {
  try {
    const initiative = db.prepare("SELECT * FROM initiatives WHERE id = ?").get(initiative_id);
    if (!initiative) {
      return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
    }

    const participants = safeJsonParse(initiative.participating_agents, [], "initiative " + initiative.id + " agents");
    let criteria;
    try {
      criteria = JSON.parse(initiative.success_criteria || "[]");
      if (!Array.isArray(criteria)) criteria = [];
    } catch {
      return { content: [{ type: "text", text: "Data corruption: initiative " + initiative.id + " has invalid JSON in success_criteria field" }], isError: true };
    }

    const tasks = db.prepare(
      `SELECT it.role, it.linked_by, t.id, t.title, t.status, t.assigned_to, t.project, t.priority
       FROM initiative_tasks it
       JOIN tasks t ON t.id = it.task_id
       WHERE it.initiative_id = ?
       ORDER BY t.priority ASC, t.created_at ASC`
    ).all(initiative_id);

    const updates = db.prepare(
      `SELECT agent_name, update_text, created_at FROM initiative_updates
       WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 10`
    ).all(initiative_id);

    const lines = [
      `# ${initiative.title}`,
      `ID: ${initiative.id} | Status: ${initiative.status} | Progress: ${initiative.progress_pct || 0}%`,
      `Owner: ${initiative.owner} | Participants: ${participants.join(", ") || "none"}`,
      initiative.target_date ? `Target: ${initiative.target_date}` : null,
      initiative.description ? `\n${initiative.description}` : null,
      "",
      "## Success Criteria",
      ...criteria.map((c, i) => `${i + 1}. ${c}`),
    ].filter(Boolean);

    if (tasks.length) {
      lines.push("", "## Linked Tasks");
      for (const t of tasks) {
        const role = t.role ? ` (${t.role})` : "";
        const assignee = t.assigned_to ? ` → ${t.assigned_to}` : "";
        lines.push(`- ${t.id} [${t.status}] P${t.priority} ${t.project}: ${t.title}${assignee}${role}`);
      }
    }

    if (updates.length) {
      lines.push("", "## Recent Updates");
      for (const u of updates) {
        lines.push(`- [${u.created_at}] ${u.agent_name}: ${u.update_text}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function updateInitiative(db, agentName, { initiative_id, status, progress_pct, description, title, participants, criteria, target_date }) {
  try {
    const existing = db.prepare("SELECT id FROM initiatives WHERE id = ?").get(initiative_id);
    if (!existing) {
      return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
    }

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (progress_pct !== undefined) updates.progress_pct = progress_pct;
    if (description !== undefined) updates.description = description;
    if (title !== undefined) updates.title = title;
    if (participants !== undefined) updates.participating_agents = JSON.stringify(participants);
    if (criteria !== undefined) updates.success_criteria = JSON.stringify(criteria);
    if (target_date !== undefined) updates.target_date = target_date;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "No fields to update." }], isError: true };
    }

    updates.updated_at = now();
    const { sql: sets, params } = buildSetClause(updates, { allowedColumns: INITIATIVE_SET_COLUMNS });
    params.push(initiative_id);

    db.prepare(`UPDATE initiatives SET ${sets} WHERE id = ?`).run(...params);

    const changes = Object.keys(updates).filter(k => k !== "updated_at").join(", ");
    return { content: [{ type: "text", text: `Initiative ${initiative_id} updated: ${changes}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function linkTaskToInitiative(db, agentName, { initiative_id, task_id, role = "" }) {
  try {
    const initiative = db.prepare("SELECT id, title FROM initiatives WHERE id = ?").get(initiative_id);
    if (!initiative) {
      return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
    }
    const task = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    }

    const id = uuid8();
    db.prepare(
      `INSERT OR IGNORE INTO initiative_tasks (id, initiative_id, task_id, role, linked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, initiative_id, task_id, role, agentName, now());

    return { content: [{ type: "text", text: `Task "${task.title}" linked to initiative "${initiative.title}"${role ? ` (role: ${role})` : ""}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function addInitiativeUpdate(db, agentName, { initiative_id, update_text }) {
  try {
    const initiative = db.prepare("SELECT id, title FROM initiatives WHERE id = ?").get(initiative_id);
    if (!initiative) {
      return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
    }

    const id = uuid8();
    db.prepare(
      `INSERT INTO initiative_updates (id, initiative_id, agent_name, update_text, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, initiative_id, agentName, update_text, now());

    return { content: [{ type: "text", text: `Update logged on "${initiative.title}": ${update_text}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
