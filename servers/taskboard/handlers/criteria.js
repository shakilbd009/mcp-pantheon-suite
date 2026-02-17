/**
 * Acceptance criteria handlers.
 */
import { now } from "../../../shared/db.js";
import { safeJsonParse } from "../../../shared/query.js";

export function setCriteria(db, agentName, { task_id, criteria }) {
  try {
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    }

    const items = criteria.map((text, i) => ({
      id: `c${i + 1}`,
      text,
      checked: false,
      checked_by: null,
    }));
    const criteriaJson = JSON.stringify(items);
    db.prepare("UPDATE tasks SET criteria = ?, updated_at = ? WHERE id = ?")
      .run(criteriaJson, now(), task_id);

    return { content: [{ type: "text", text: `Set ${criteria.length} acceptance criteria on task ${task_id}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function checkCriterion(db, agentName, { task_id, criterion_id, checked = true }) {
  try {
    const task = db.prepare("SELECT id, criteria FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    }

    const items = safeJsonParse(task.criteria, [], "checkCriterion task " + task_id + " criteria");

    const item = items.find((c) => c.id === criterion_id);
    if (!item) {
      const ids = items.map((c) => c.id).join(", ");
      return { content: [{ type: "text", text: `Criterion '${criterion_id}' not found. Available: ${ids || "none"}` }], isError: true };
    }

    item.checked = checked;
    item.checked_by = checked ? agentName : null;

    db.prepare("UPDATE tasks SET criteria = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(items), now(), task_id);

    const done = items.filter((c) => c.checked).length;
    return { content: [{ type: "text", text: `Criterion ${criterion_id} ${checked ? "checked" : "unchecked"} on task ${task_id} (${done}/${items.length} done)` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
