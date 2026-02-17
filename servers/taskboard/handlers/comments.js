/**
 * Comment and review handlers.
 */
import { uuid8 } from "../../../shared/db.js";

export function addComment(db, agentName, { task_id, content }) {
  try {
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }] };
    }

    const id = uuid8();
    db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content) VALUES (?, ?, ?, ?)"
    ).run(id, task_id, agentName, content);

    return { content: [{ type: "text", text: `Comment added to task ${task_id} (id: ${id})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function submitReview(db, agentName, { task_id, verdict, content, categories = [] }) {
  try {
    const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(task_id);
    if (!task) {
      return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    }

    const id = uuid8();
    const catsJson = JSON.stringify(categories);
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author, content, type, verdict, categories)
       VALUES (?, ?, ?, ?, 'review', ?, ?)`
    ).run(id, task_id, agentName, content, verdict, catsJson);

    return { content: [{ type: "text", text: `Review submitted for ${task_id}: ${verdict.toUpperCase()} (id: ${id})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
