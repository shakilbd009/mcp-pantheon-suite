/**
 * Project-level handlers (board view).
 */
import { OPS_STATUSES, FORGE_STATUSES } from "./schema.js";

export function getBoard(db, agentName, { project }) {
  try {
    const rows = db.prepare(
      "SELECT * FROM tasks WHERE project = ? ORDER BY priority ASC, created_at ASC"
    ).all(project);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No tasks found for project '${project}'.` }] };
    }

    // Get subtask counts
    const subtaskCounts = {};
    const countRows = db.prepare(
      `SELECT parent_task_id, COUNT(*) as total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
       FROM tasks WHERE parent_task_id IS NOT NULL GROUP BY parent_task_id`
    ).all();
    for (const r of countRows) subtaskCounts[r.parent_task_id] = r;

    // Group by status
    const statusList = project.startsWith("ops/") ? OPS_STATUSES : FORGE_STATUSES;
    const columns = {};
    for (const s of statusList) columns[s] = [];
    for (const t of rows) {
      if (!columns[t.status]) columns[t.status] = [];
      columns[t.status].push(t);
    }

    // Build child map for nesting
    const childMap = {};
    for (const t of rows) {
      if (t.parent_task_id) {
        if (!childMap[t.parent_task_id]) childMap[t.parent_task_id] = [];
        childMap[t.parent_task_id].push(t);
      }
    }

    const sections = [];
    for (const [status, tasks] of Object.entries(columns)) {
      const topLevel = tasks.filter((t) => !t.parent_task_id);
      if (topLevel.length === 0) continue;
      const items = topLevel.map((t) => {
        const assignee = t.assigned_to ? ` (${t.assigned_to})` : "";
        const sc = subtaskCounts[t.id];
        const childInfo = sc ? ` [${sc.done}/${sc.total} subtasks]` : "";
        let line = `  ${t.id}: ${t.title}${assignee}${childInfo}`;
        const children = childMap[t.id] || [];
        for (const child of children) {
          const ca = child.assigned_to ? ` (${child.assigned_to})` : "";
          line += `\n    └ ${child.id}: ${child.title} [${child.status}]${ca}`;
        }
        return line;
      });
      sections.push(`[${status.toUpperCase()}] (${topLevel.length})\n${items.join("\n")}`);
    }

    return { content: [{ type: "text", text: `Sprint Board: ${project}\n${"=".repeat(40)}\n\n${sections.join("\n\n")}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
