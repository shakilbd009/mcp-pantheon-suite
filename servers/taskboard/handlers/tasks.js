/**
 * Task CRUD handlers: create, list, search, get, update, delete.
 */
import { uuid8, now } from "../../../shared/db.js";
import { buildWhereClause, buildSetClause, safeJsonParse } from "../../../shared/query.js";
import { getTransitions, getDefaultStatus, OPS_STATUSES, FORGE_STATUSES } from "./schema.js";

export function createTask(db, agentName, { project, title, description = "", priority = 5, status, assigned_to, parent_task_id, due_date }) {
  try {
    const id = uuid8();
    const ts = now();

    let resolvedProject = project;

    if (parent_task_id) {
      const parent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent_task_id);
      if (!parent) {
        return { content: [{ type: "text", text: `Error: Parent task '${parent_task_id}' not found.` }], isError: true };
      }
      if (parent.parent_task_id) {
        return { content: [{ type: "text", text: `Error: Cannot nest subtasks more than one level deep.` }], isError: true };
      }
      resolvedProject = parent.project;
    }

    if (!resolvedProject) {
      return { content: [{ type: "text", text: `Error: 'project' is required when not creating a subtask.` }], isError: true };
    }

    const resolvedStatus = status || getDefaultStatus(resolvedProject);

    const createTx = db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks
         (id, project, title, description, status, assigned_to, priority, created_by, created_at, updated_at, parent_task_id, due_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, resolvedProject, title, description, resolvedStatus, assigned_to || null, priority, agentName, ts, ts, parent_task_id || null, due_date || null);

      const histId = uuid8();
      db.prepare(
        `INSERT INTO task_history (id, task_id, from_status, to_status, changed_by, changed_at)
         VALUES (?, ?, NULL, ?, ?, ?)`
      ).run(histId, id, resolvedStatus, agentName, ts);
    });
    createTx();

    const subtaskNote = parent_task_id ? ` (subtask of ${parent_task_id})` : "";
    return { content: [{ type: "text", text: `Task created: ${id} — "${title}" [${resolvedStatus}] in project ${resolvedProject}${subtaskNote}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function listTasks(db, agentName, { project, status = "all", assigned_to, limit = 30 }) {
  try {
    const filters = [];
    if (project) filters.push({ column: "project", value: project });
    if (status && status !== "all") filters.push({ column: "status", value: status });
    if (assigned_to) filters.push({ column: "assigned_to", value: assigned_to });

    const { sql: where, params } = buildWhereClause(filters);
    let sql = "SELECT * FROM tasks";
    if (where) sql += " WHERE " + where;
    sql += " ORDER BY priority ASC, created_at ASC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No tasks found matching filters." }] };
    }

    const subtaskCounts = {};
    const parentIds = rows.filter((t) => !t.parent_task_id).map((t) => t.id);
    if (parentIds.length > 0) {
      const countRows = db.prepare(
        `SELECT parent_task_id, COUNT(*) as total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
         FROM tasks WHERE parent_task_id IS NOT NULL GROUP BY parent_task_id`
      ).all();
      for (const r of countRows) subtaskCounts[r.parent_task_id] = r;
    }

    const lines = rows.map((t) => {
      const assignee = t.assigned_to ? ` → ${t.assigned_to}` : "";
      const branch = t.branch ? ` [${t.branch}]` : "";
      const prInfo = t.pr_merged ? " (PR merged)" : "";
      const subtask = t.parent_task_id ? ` (subtask of ${t.parent_task_id})` : "";
      const childInfo = subtaskCounts[t.id] ? ` [${subtaskCounts[t.id].done}/${subtaskCounts[t.id].total} subtasks]` : "";
      return `${t.id} | [${t.status}] P${t.priority} | ${t.project}: ${t.title}${assignee}${branch}${prInfo}${subtask}${childInfo}`;
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function searchTasks(db, agentName, { query, limit = 20 }) {
  try {
    let rows;
    try {
      rows = db.prepare(
        `SELECT t.* FROM tasks t
         JOIN tasks_fts fts ON t.rowid = fts.rowid
         WHERE tasks_fts MATCH ?
         ORDER BY rank LIMIT ?`
      ).all(query, limit);
    } catch {
      // Fallback to LIKE if FTS5 is unavailable
      const pattern = `%${query}%`;
      rows = db.prepare(
        "SELECT * FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT ?"
      ).all(pattern, pattern, limit);
    }

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No tasks found matching "${query}".` }] };
    }

    const lines = rows.map((t) => {
      const assignee = t.assigned_to ? ` → ${t.assigned_to}` : "";
      return `${t.id} | [${t.status}] P${t.priority} | ${t.project}: ${t.title}${assignee}`;
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function getTask(db, agentName, { task_id }) {
  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }] };
    }

    const comments = db.prepare(
      "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"
    ).all(task_id);

    const lines = [
      `Task: ${task.id}`,
      `Project: ${task.project}`,
      `Title: ${task.title}`,
      `Status: ${task.status}`,
      `Priority: ${task.priority}`,
      `Assigned: ${task.assigned_to || "unassigned"}`,
      `Branch: ${task.branch || "none"}`,
      `PR: ${task.pr_url || (task.pr_number ? `#${task.pr_number}` : "none")}${task.pr_merged ? " (MERGED)" : ""}`,
      `Spec: ${task.spec_file || "none"}`,
      `Design: ${task.design_file || "none"}`,
      `Due: ${task.due_date || "none"}`,
      `Created by: ${task.created_by} at ${task.created_at}`,
      `Updated: ${task.updated_at}`,
      ``,
      `Description:`,
      task.description || "(none)",
    ];

    // Acceptance criteria checklist
    let criteriaItems = [];
    try {
      criteriaItems = JSON.parse(task.criteria || "[]");
      if (!Array.isArray(criteriaItems)) criteriaItems = [];
    } catch {
      return { content: [{ type: "text", text: "Data corruption: task " + task.id + " has invalid JSON in criteria field" }], isError: true };
    }
    if (criteriaItems.length > 0) {
      const done = criteriaItems.filter((c) => c.checked).length;
      lines.push("", `--- Acceptance Criteria (${done}/${criteriaItems.length}) ---`);
      for (const c of criteriaItems) {
        const mark = c.checked ? "x" : " ";
        const by = c.checked_by ? ` (${c.checked_by})` : "";
        lines.push(`  [${mark}] ${c.id}: ${c.text}${by}`);
      }
    }

    const reviews = comments.filter((c) => c.type === "review");
    const regularComments = comments.filter((c) => c.type !== "review");

    if (reviews.length > 0) {
      lines.push("", `--- Reviews (${reviews.length}) ---`);
      for (const r of reviews) {
        const cats = safeJsonParse(r.categories, [], "review " + r.id + " categories");
        const catStr = cats.length > 0 ? ` [${cats.join(", ")}]` : "";
        lines.push(`[${r.created_at}] ${r.author}: ${r.verdict.toUpperCase()}${catStr}`);
        lines.push(`  ${r.content}`);
      }
    }

    if (regularComments.length > 0) {
      lines.push("", `--- Comments (${regularComments.length}) ---`);
      for (const c of regularComments) {
        lines.push(`[${c.created_at}] ${c.author}: ${c.content}`);
      }
    }

    // Dependencies
    const blockedBy = db.prepare(
      `SELECT t.id, t.title, t.status FROM tasks t
       JOIN task_deps d ON d.depends_on_id = t.id
       WHERE d.task_id = ?`
    ).all(task_id);
    const blocks = db.prepare(
      `SELECT t.id, t.title, t.status FROM tasks t
       JOIN task_deps d ON d.task_id = t.id
       WHERE d.depends_on_id = ?`
    ).all(task_id);

    if (blockedBy.length > 0) {
      lines.push("", `--- Blocked By (${blockedBy.length}) ---`);
      for (const dep of blockedBy) {
        lines.push(`  ${dep.id}: ${dep.title} [${dep.status}]`);
      }
    }
    if (blocks.length > 0) {
      lines.push("", `--- Blocks (${blocks.length}) ---`);
      for (const dep of blocks) {
        lines.push(`  ${dep.id}: ${dep.title} [${dep.status}]`);
      }
    }

    // Parent task
    if (task.parent_task_id) {
      const parent = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(task.parent_task_id);
      if (parent) {
        lines.push("", `--- Parent Task ---`);
        lines.push(`  ${parent.id}: ${parent.title} [${parent.status}]`);
      }
    }

    // Child tasks (subtasks)
    const children = db.prepare(
      "SELECT id, title, status, assigned_to FROM tasks WHERE parent_task_id = ? ORDER BY priority ASC, created_at ASC"
    ).all(task_id);
    if (children.length > 0) {
      const doneCount = children.filter((c) => c.status === "done").length;
      lines.push("", `--- Subtasks (${doneCount}/${children.length} done) ---`);
      for (const child of children) {
        const assignee = child.assigned_to ? ` (${child.assigned_to})` : "";
        lines.push(`  ${child.id}: ${child.title} [${child.status}]${assignee}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function updateTask(db, agentName, { task_id, status, assigned_to, branch, spec_file, design_file, title, description, priority, pr_url, pr_number, pr_merged, parent_task_id, due_date, expected_status }) {
  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }] };
    }

    // Optimistic lock
    if (expected_status && task.status !== expected_status) {
      return { content: [{ type: "text", text: `No-op: task ${task_id} is now '${task.status}' (expected '${expected_status}'). Another agent already moved it.` }] };
    }

    // Same-status no-op
    if (status && status === task.status) {
      status = undefined;
    }

    // Status transition validation
    if (status && status !== task.status) {
      const transitions = getTransitions(task.project);
      const allowed = transitions[task.status];
      if (allowed && !allowed.includes(status)) {
        const hint = allowed.length > 0 ? `Allowed: ${task.status} → ${allowed.join(" | ")}` : `No transitions from '${task.status}'`;
        const pipeline = task.project && task.project.startsWith("ops/") ? "ops" : "forge";
        return { content: [{ type: "text", text: `Error: Invalid status transition '${task.status}' → '${status}' (${pipeline} pipeline). ${hint}` }], isError: true };
      }
    }

    // Done-guard: reject if children aren't all done
    if (status === "done") {
      const nonDoneChildren = db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE parent_task_id = ? AND status != 'done'"
      ).get(task_id);
      if (nonDoneChildren && nonDoneChildren.cnt > 0) {
        return { content: [{ type: "text", text: `Error: Cannot mark task as done — ${nonDoneChildren.cnt} subtask(s) are not done yet.` }], isError: true };
      }
    }

    // Validate parent_task_id changes
    if (parent_task_id !== undefined) {
      if (parent_task_id !== null) {
        if (parent_task_id === task_id) {
          return { content: [{ type: "text", text: `Error: A task cannot be its own parent.` }], isError: true };
        }
        const parent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent_task_id);
        if (!parent) {
          return { content: [{ type: "text", text: `Error: Parent task '${parent_task_id}' not found.` }], isError: true };
        }
        if (parent.parent_task_id) {
          return { content: [{ type: "text", text: `Error: Cannot nest subtasks more than one level deep.` }], isError: true };
        }
        const hasChildren = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE parent_task_id = ?").get(task_id);
        if (hasChildren && hasChildren.cnt > 0) {
          return { content: [{ type: "text", text: `Error: Cannot make a parent task into a subtask.` }], isError: true };
        }
      }
    }

    // Build update
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (branch !== undefined) updates.branch = branch;
    if (spec_file !== undefined) updates.spec_file = spec_file;
    if (design_file !== undefined) updates.design_file = design_file;
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (priority !== undefined) updates.priority = priority;
    if (pr_url !== undefined) updates.pr_url = pr_url;
    if (pr_number !== undefined) updates.pr_number = pr_number;
    if (pr_merged !== undefined) updates.pr_merged = pr_merged;
    if (parent_task_id !== undefined) updates.parent_task_id = parent_task_id;
    if (due_date !== undefined) updates.due_date = due_date;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "No fields to update." }] };
    }

    updates.updated_at = now();
    const { sql: sets, params: vals } = buildSetClause(updates);
    vals.push(task_id);
    const updateTx = db.transaction(() => {
      db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...vals);

      // Auto-comment on status transitions + record history
      if (status && status !== task.status) {
        const commentId = uuid8();
        db.prepare(
          "INSERT INTO task_comments (id, task_id, author, content) VALUES (?, ?, ?, ?)"
        ).run(commentId, task_id, agentName, `Status: ${task.status} → ${status}`);

        // Compute duration from last transition
        const lastHist = db.prepare(
          "SELECT changed_at FROM task_history WHERE task_id = ? ORDER BY changed_at DESC LIMIT 1"
        ).get(task_id);
        let duration = null;
        if (lastHist && lastHist.changed_at) {
          duration = Math.round((Date.now() - new Date(lastHist.changed_at).getTime()) / 1000);
        }
        const histId = uuid8();
        db.prepare(
          `INSERT INTO task_history (id, task_id, from_status, to_status, changed_by, changed_at, duration_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(histId, task_id, task.status, status, agentName, now(), duration);
      }
    });
    updateTx();

    const changed = Object.keys(updates).filter((k) => k !== "updated_at").join(", ");
    return { content: [{ type: "text", text: `Task ${task_id} updated: ${changed}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function deleteTask(db, agentName, { task_id, confirm }) {
  try {
    if (!confirm) {
      return { content: [{ type: "text", text: "Deletion not confirmed. Set confirm: true to proceed." }] };
    }

    const task = db.prepare("SELECT id, title, project FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    }

    const subtasks = db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").all(task_id);
    const deleteTx = db.transaction(() => {
      for (const sub of subtasks) {
        db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(sub.id);
        db.prepare("DELETE FROM task_deps WHERE task_id = ? OR depends_on_id = ?").run(sub.id, sub.id);
        db.prepare("DELETE FROM task_history WHERE task_id = ?").run(sub.id);
      }
      db.prepare("DELETE FROM tasks WHERE parent_task_id = ?").run(task_id);

      db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(task_id);
      db.prepare("DELETE FROM task_deps WHERE task_id = ? OR depends_on_id = ?").run(task_id, task_id);
      db.prepare("DELETE FROM task_history WHERE task_id = ?").run(task_id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task_id);
    });
    deleteTx();

    return { content: [{ type: "text", text: `Deleted task ${task_id}: "${task.title}" (project: ${task.project})${subtasks.length > 0 ? ` and ${subtasks.length} subtask(s)` : ""}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
