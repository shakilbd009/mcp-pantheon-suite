/**
 * Task dependency handlers.
 */

export function addDependency(db, agentName, { task_id, depends_on_id }) {
  try {
    if (task_id === depends_on_id) {
      return { content: [{ type: "text", text: "Error: A task cannot depend on itself." }], isError: true };
    }

    const t1 = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(task_id);
    const t2 = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(depends_on_id);
    if (!t1) return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
    if (!t2) return { content: [{ type: "text", text: `Task '${depends_on_id}' not found.` }], isError: true };

    // BFS cycle detection
    const visited = new Set();
    const queue = [task_id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === depends_on_id) {
        return { content: [{ type: "text", text: `Error: Adding this dependency would create a circular chain.` }], isError: true };
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const dependents = db.prepare(
        "SELECT task_id FROM task_deps WHERE depends_on_id = ?"
      ).all(current);
      for (const d of dependents) queue.push(d.task_id);
    }

    db.prepare(
      "INSERT OR IGNORE INTO task_deps (task_id, depends_on_id, created_by) VALUES (?, ?, ?)"
    ).run(task_id, depends_on_id, agentName);

    return { content: [{ type: "text", text: `Dependency added: "${t1.title}" is now blocked by "${t2.title}"` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

export function removeDependency(db, agentName, { task_id, depends_on_id }) {
  try {
    const result = db.prepare(
      "DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?"
    ).run(task_id, depends_on_id);

    if (result.changes === 0) {
      return { content: [{ type: "text", text: "Dependency not found." }], isError: true };
    }
    return { content: [{ type: "text", text: `Dependency removed: ${task_id} no longer blocked by ${depends_on_id}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
