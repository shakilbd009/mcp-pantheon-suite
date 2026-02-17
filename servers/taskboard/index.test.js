/**
 * Tests for taskboard handlers.
 * Each test gets a fresh :memory: SQLite DB via beforeEach.
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initSchema,
  createTask,
  listTasks,
  searchTasks,
  getTask,
  updateTask,
  addComment,
  submitReview,
  setCriteria,
  checkCriterion,
  addDependency,
  removeDependency,
  deleteTask,
} from "./handlers/index.js";

const AGENT = "test-agent";

// FTS5 detection
const hasFts5 = (() => {
  const testDb = new Database(":memory:");
  try { testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)"); return true; }
  catch { return false; }
  finally { testDb.close(); }
})();

let db;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

// Helper: create a task and return the ID extracted from result text
function quickCreate(overrides = {}) {
  const params = {
    project: "forge/test",
    title: "Test task",
    description: "",
    priority: 5,
    ...overrides,
  };
  const result = createTask(db, AGENT, params);
  const match = result.content[0].text.match(/Task created: ([0-9a-f]{8})/);
  return match ? match[1] : null;
}

// ── create_task ─────────────────────────────────────────────────────

describe("createTask", () => {
  it("creates a task with project and title", () => {
    const result = createTask(db, AGENT, {
      project: "forge/my-app",
      title: "Build login page",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Task created:");
    expect(result.content[0].text).toContain("Build login page");

    // Verify in DB
    const row = db.prepare("SELECT * FROM tasks WHERE title = ?").get("Build login page");
    expect(row).toBeTruthy();
    expect(row.project).toBe("forge/my-app");
    expect(row.created_by).toBe(AGENT);
  });

  it("errors when project is missing and no parent", () => {
    const result = createTask(db, AGENT, { title: "No project" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'project' is required");
  });

  it("defaults forge/* to backlog, ops/* to todo", () => {
    const forgeId = quickCreate({ project: "forge/app" });
    const opsId = quickCreate({ project: "ops/deploy" });

    const forgeTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(forgeId);
    const opsTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(opsId);

    expect(forgeTask.status).toBe("backlog");
    expect(opsTask.status).toBe("todo");
  });
});

// ── update_task — optimistic lock ───────────────────────────────────

describe("updateTask — optimistic lock", () => {
  it("succeeds when expected_status matches", () => {
    const id = quickCreate();
    const result = updateTask(db, AGENT, {
      task_id: id,
      status: "specced",
      expected_status: "backlog",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("updated");

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id);
    expect(task.status).toBe("specced");
  });

  it("no-ops when expected_status does not match", () => {
    const id = quickCreate();
    const result = updateTask(db, AGENT, {
      task_id: id,
      status: "specced",
      expected_status: "designed",
    });
    expect(result.content[0].text).toContain("No-op");
    expect(result.content[0].text).toContain("expected 'designed'");

    // Status unchanged
    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id);
    expect(task.status).toBe("backlog");
  });
});

// ── add_dependency / remove_dependency ──────────────────────────────

describe("dependencies", () => {
  it("rejects self-reference", () => {
    const id = quickCreate();
    const result = addDependency(db, AGENT, { task_id: id, depends_on_id: id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot depend on itself");
  });

  it("detects circular dependency via BFS", () => {
    const a = quickCreate({ title: "Task A" });
    const b = quickCreate({ title: "Task B" });
    const c = quickCreate({ title: "Task C" });

    // A depends on B, B depends on C
    addDependency(db, AGENT, { task_id: a, depends_on_id: b });
    addDependency(db, AGENT, { task_id: b, depends_on_id: c });

    // C depends on A would create cycle
    const result = addDependency(db, AGENT, { task_id: c, depends_on_id: a });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("circular");
  });

  it("adds and removes dependency", () => {
    const a = quickCreate({ title: "Task A" });
    const b = quickCreate({ title: "Task B" });

    const addResult = addDependency(db, AGENT, { task_id: a, depends_on_id: b });
    expect(addResult.isError).toBeUndefined();
    expect(addResult.content[0].text).toContain("blocked by");

    // Verify in DB
    const dep = db.prepare("SELECT * FROM task_deps WHERE task_id = ? AND depends_on_id = ?").get(a, b);
    expect(dep).toBeTruthy();

    // Remove
    const removeResult = removeDependency(db, AGENT, { task_id: a, depends_on_id: b });
    expect(removeResult.isError).toBeUndefined();
    expect(removeResult.content[0].text).toContain("removed");

    const depAfter = db.prepare("SELECT * FROM task_deps WHERE task_id = ? AND depends_on_id = ?").get(a, b);
    expect(depAfter).toBeUndefined();
  });
});

// ── set_criteria / check_criterion ──────────────────────────────────

describe("criteria", () => {
  it("sets criteria on a task", () => {
    const id = quickCreate();
    const result = setCriteria(db, AGENT, {
      task_id: id,
      criteria: ["Tests pass", "No lint errors", "Docs updated"],
    });
    expect(result.content[0].text).toContain("3 acceptance criteria");

    const task = db.prepare("SELECT criteria FROM tasks WHERE id = ?").get(id);
    const items = JSON.parse(task.criteria);
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe("c1");
    expect(items[0].text).toBe("Tests pass");
    expect(items[0].checked).toBe(false);
  });

  it("checks and unchecks a criterion", () => {
    const id = quickCreate();
    setCriteria(db, AGENT, { task_id: id, criteria: ["First", "Second"] });

    // Check c1
    const checkResult = checkCriterion(db, AGENT, { task_id: id, criterion_id: "c1", checked: true });
    expect(checkResult.content[0].text).toContain("checked");
    expect(checkResult.content[0].text).toContain("1/2 done");

    // Verify checked_by
    const task = db.prepare("SELECT criteria FROM tasks WHERE id = ?").get(id);
    const items = JSON.parse(task.criteria);
    expect(items[0].checked).toBe(true);
    expect(items[0].checked_by).toBe(AGENT);

    // Uncheck c1
    const uncheckResult = checkCriterion(db, AGENT, { task_id: id, criterion_id: "c1", checked: false });
    expect(uncheckResult.content[0].text).toContain("unchecked");
  });

  it("errors on invalid criterion ID", () => {
    const id = quickCreate();
    setCriteria(db, AGENT, { task_id: id, criteria: ["Only one"] });

    const result = checkCriterion(db, AGENT, { task_id: id, criterion_id: "c99" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

// ── search_tasks (FTS5 conditional) ─────────────────────────────────

describe.skipIf(!hasFts5)("searchTasks (FTS5)", () => {
  it("finds matching tasks and returns empty for no match", () => {
    quickCreate({ title: "Authentication module", description: "JWT-based auth" });
    quickCreate({ title: "Dashboard component", description: "React charts" });

    const found = searchTasks(db, AGENT, { query: "Authentication" });
    expect(found.content[0].text).toContain("Authentication module");

    const notFound = searchTasks(db, AGENT, { query: "zzz_nonexistent_zzz" });
    expect(notFound.content[0].text).toContain("No tasks found");
  });
});

// ── delete_task (cascade) ───────────────────────────────────────────

describe("deleteTask", () => {
  it("cascades deletion to comments, deps, and subtasks", () => {
    const parentId = quickCreate({ title: "Parent task" });
    const childId = quickCreate({ title: "Child task", parent_task_id: parentId });
    const otherId = quickCreate({ title: "Other task" });

    // Add comment on parent
    addComment(db, AGENT, { task_id: parentId, content: "Build note" });
    // Add dependency
    addDependency(db, AGENT, { task_id: parentId, depends_on_id: otherId });

    // Delete parent
    const result = deleteTask(db, AGENT, { task_id: parentId, confirm: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Deleted");
    expect(result.content[0].text).toContain("1 subtask");

    // Verify cascade
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(childId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM task_comments WHERE task_id = ?").get(parentId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM task_deps WHERE task_id = ?").get(parentId)).toBeUndefined();

    // Other task unaffected
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(otherId)).toBeTruthy();
  });
});

// ── Subtask depth guard ─────────────────────────────────────────────

describe("subtask depth guard", () => {
  it("rejects nesting subtasks more than one level", () => {
    const a = quickCreate({ title: "Grandparent" });
    const b = quickCreate({ title: "Parent", parent_task_id: a });

    // Try to create sub-sub-task
    const result = createTask(db, AGENT, {
      title: "Child of child",
      parent_task_id: b,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot nest subtasks more than one level");
  });
});

// ── submit_review ───────────────────────────────────────────────────

describe("submitReview", () => {
  it("records approve and reject verdicts with categories", () => {
    const id = quickCreate();

    const approveResult = submitReview(db, AGENT, {
      task_id: id,
      verdict: "approve",
      content: "LGTM, clean code",
      categories: ["style"],
    });
    expect(approveResult.content[0].text).toContain("APPROVE");

    const rejectResult = submitReview(db, "reviewer-2", {
      task_id: id,
      verdict: "reject",
      content: "Missing error handling",
      categories: ["bug", "security"],
    });
    expect(rejectResult.content[0].text).toContain("REJECT");

    // Verify in DB
    const reviews = db.prepare(
      "SELECT * FROM task_comments WHERE task_id = ? AND type = 'review' ORDER BY created_at"
    ).all(id);
    expect(reviews).toHaveLength(2);
    expect(reviews[0].verdict).toBe("approve");
    expect(reviews[0].categories).toBe('["style"]');
    expect(reviews[1].verdict).toBe("reject");
    expect(reviews[1].author).toBe("reviewer-2");
    expect(JSON.parse(reviews[1].categories)).toEqual(["bug", "security"]);
  });
});
