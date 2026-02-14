#!/usr/bin/env node
/**
 * MCP Taskboard Server — A full-featured sprint board.
 *
 * Provides task CRUD with two status pipelines, subtasks, dependencies,
 * acceptance criteria, FTS5 search, and cross-cutting initiatives.
 *
 * Tools:
 *   - create_task: Create a new task on the board
 *   - list_tasks: List tasks with filters (project, status, assignee)
 *   - search_tasks: Full-text search across tasks
 *   - get_task: Get full task details with comments
 *   - update_task: Update task fields (status, assignee, branch, etc.)
 *   - add_comment: Add a comment to a task
 *   - submit_review: Submit a structured review verdict
 *   - set_criteria: Set acceptance criteria checklist
 *   - check_criterion: Check/uncheck an acceptance criterion
 *   - get_board: Get a sprint board overview for a project
 *   - add_dependency: Add a dependency between tasks
 *   - delete_task: Delete a task and related data
 *   - remove_dependency: Remove a dependency link
 *   - create_initiative: Create a cross-cutting initiative
 *   - list_initiatives: List initiatives with filters
 *   - get_initiative: Get full initiative details
 *   - update_initiative: Update an initiative
 *   - link_task_to_initiative: Link a task to an initiative
 *   - add_initiative_update: Log a progress note on an initiative
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDb, getAgentName, uuid8, now } from "../../shared/db.js";

const SERVER_NAME = "taskboard";

// ── Schema ───────────────────────────────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      assigned_to TEXT,
      priority INTEGER DEFAULT 5,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_task_id TEXT REFERENCES tasks(id),
      branch TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      pr_merged INTEGER DEFAULT 0,
      spec_file TEXT,
      design_file TEXT,
      criteria TEXT,
      due_date TEXT
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'comment',
      verdict TEXT,
      categories TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (task_id, depends_on_id)
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT NOT NULL,
      duration_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS initiatives (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      owner TEXT,
      participating_agents TEXT DEFAULT '[]',
      success_criteria TEXT DEFAULT '[]',
      progress_pct INTEGER DEFAULT 0,
      target_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS initiative_tasks (
      id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      role TEXT DEFAULT '',
      linked_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(initiative_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS initiative_updates (
      id TEXT PRIMARY KEY,
      initiative_id TEXT NOT NULL REFERENCES initiatives(id),
      agent_name TEXT NOT NULL,
      update_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
  `);

  // FTS5 virtual table — may fail on SQLite builds without FTS5 extension
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        title, description, content=tasks, content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
      END;
    `);
  } catch {
    // FTS5 not available — search_tasks will use LIKE fallback
  }
}

// ── Pipelines ────────────────────────────────────────────────────────

// Full 9-stage software development lifecycle
const FORGE_STATUSES = [
  "backlog", "specced", "designed", "ready", "in_progress",
  "in_review", "testing", "acceptance", "done",
];

const FORGE_TRANSITIONS = {
  backlog: ["specced"],
  specced: ["designed"],
  designed: ["ready"],
  ready: ["in_progress"],
  in_progress: ["in_review"],
  in_review: ["testing", "in_progress"],
  testing: ["acceptance", "in_progress"],
  acceptance: ["done", "in_progress"],
  done: [],
};

// Lightweight pipeline for non-engineering work (ops/* projects)
const OPS_STATUSES = ["todo", "in_progress", "blocked", "done"];

const OPS_TRANSITIONS = {
  todo: ["in_progress"],
  in_progress: ["blocked", "done"],
  blocked: ["in_progress"],
  done: [],
};

// Combined valid statuses (union of both pipelines)
const VALID_STATUSES = [...new Set([...FORGE_STATUSES, ...OPS_STATUSES])];

/**
 * Get the allowed transitions for a task based on its project prefix.
 * ops/* projects use the lightweight pipeline, everything else uses the full pipeline.
 */
function getTransitions(project) {
  if (project && project.startsWith("ops/")) {
    return OPS_TRANSITIONS;
  }
  return FORGE_TRANSITIONS;
}

/**
 * Get the default initial status for a project.
 * ops/* projects start as "todo", others start as "backlog".
 */
function getDefaultStatus(project) {
  if (project && project.startsWith("ops/")) {
    return "todo";
  }
  return "backlog";
}

// ── Init ─────────────────────────────────────────────────────────────

const db = createDb("taskboard");
initSchema(db);

const server = new McpServer({
  name: "mcp-taskboard",
  version: "1.0.0",
});

// ── Tools ────────────────────────────────────────────────────────────

server.tool(
  "create_task",
  "Create a new task. Use project prefix to select pipeline: 'forge/*' for full dev lifecycle (backlog→specced→designed→ready→in_progress→in_review→testing→acceptance→done), 'ops/*' for lightweight flow (todo→in_progress→blocked→done). Returns the task ID. Set parent_task_id to create a subtask.",
  {
    project: z.string().optional().describe("Project name (required unless parent_task_id is set)"),
    title: z.string().max(200).describe("Short task title"),
    description: z.string().max(10000).default("").describe("Detailed description, acceptance criteria, etc."),
    priority: z.number().min(1).max(10).default(5).describe("Priority 1 (highest) to 10 (lowest)"),
    status: z.enum(VALID_STATUSES).optional().describe("Initial status (defaults to 'backlog' for forge/* or 'todo' for ops/* projects)"),
    assigned_to: z.string().optional().describe("Agent or person to assign to"),
    parent_task_id: z.string().optional().describe("Parent task ID to create this as a subtask (max depth 1)"),
    due_date: z.string().optional().describe("Due date in ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)"),
  },
  async ({ project, title, description, priority, status, assigned_to, parent_task_id, due_date }) => {
    try {
      const agent = getAgentName();
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
        ).run(id, resolvedProject, title, description, resolvedStatus, assigned_to || null, priority, agent, ts, ts, parent_task_id || null, due_date || null);

        const histId = uuid8();
        db.prepare(
          `INSERT INTO task_history (id, task_id, from_status, to_status, changed_by, changed_at)
           VALUES (?, ?, NULL, ?, ?, ?)`
        ).run(histId, id, resolvedStatus, agent, ts);
      });
      createTx();

      const subtaskNote = parent_task_id ? ` (subtask of ${parent_task_id})` : "";
      return { content: [{ type: "text", text: `Task created: ${id} — "${title}" [${resolvedStatus}] in project ${resolvedProject}${subtaskNote}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_tasks",
  "List tasks from the sprint board, with optional filters.",
  {
    project: z.string().optional().describe("Filter by project name"),
    status: z.enum([...VALID_STATUSES, "all"]).default("all").describe("Filter by status"),
    assigned_to: z.string().optional().describe("Filter by assignee"),
    limit: z.number().min(1).max(100).default(30).describe("Max results"),
  },
  async ({ project, status, assigned_to, limit }) => {
    try {
      const clauses = [];
      const params = [];

      if (project) { clauses.push("project = ?"); params.push(project); }
      if (status && status !== "all") { clauses.push("status = ?"); params.push(status); }
      if (assigned_to) { clauses.push("assigned_to = ?"); params.push(assigned_to); }

      let sql = "SELECT * FROM tasks";
      if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
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
);

server.tool(
  "search_tasks",
  "Full-text search across all tasks by title and description.",
  {
    query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, prefix*)"),
    limit: z.number().min(1).max(100).default(20).describe("Max results"),
  },
  async ({ query, limit }) => {
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
);

server.tool(
  "get_task",
  "Get full details of a task including its comment thread.",
  {
    task_id: z.string().describe("The task ID"),
  },
  async ({ task_id }) => {
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
      try { criteriaItems = JSON.parse(task.criteria || "[]"); } catch {}
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
          const cats = r.categories ? JSON.parse(r.categories) : [];
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
);

server.tool(
  "update_task",
  "Update a task's fields. Use this to transition status, assign tasks, set branches, etc.",
  {
    task_id: z.string().describe("The task ID to update"),
    status: z.enum(VALID_STATUSES).optional().describe("New status"),
    assigned_to: z.string().optional().describe("Assign to agent"),
    branch: z.string().optional().describe("Git branch name"),
    spec_file: z.string().optional().describe("Path to spec file"),
    design_file: z.string().optional().describe("Path to design doc"),
    title: z.string().optional().describe("Updated title"),
    description: z.string().optional().describe("Updated description"),
    priority: z.number().min(1).max(10).optional().describe("Updated priority"),
    pr_url: z.string().optional().describe("GitHub PR URL"),
    pr_number: z.number().int().optional().describe("GitHub PR number"),
    pr_merged: z.number().int().min(0).max(1).optional().describe("1 if PR is merged, 0 otherwise"),
    parent_task_id: z.string().nullable().optional().describe("Set parent task (null to remove)"),
    due_date: z.string().nullable().optional().describe("Due date in ISO format (null to remove)"),
    expected_status: z.enum(VALID_STATUSES).optional().describe("Optimistic lock: only update if current status matches this value. No-ops gracefully on mismatch."),
  },
  async ({ task_id, status, assigned_to, branch, spec_file, design_file, title, description, priority, pr_url, pr_number, pr_merged, parent_task_id, due_date, expected_status }) => {
    try {
      const agent = getAgentName();

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
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const vals = [...Object.values(updates), task_id];
      const updateTx = db.transaction(() => {
        db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...vals);

        // Auto-comment on status transitions + record history
        if (status && status !== task.status) {
          const commentId = uuid8();
          db.prepare(
            "INSERT INTO task_comments (id, task_id, author, content) VALUES (?, ?, ?, ?)"
          ).run(commentId, task_id, agent, `Status: ${task.status} → ${status}`);

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
          ).run(histId, task_id, task.status, status, agent, now(), duration);
        }
      });
      updateTx();

      const changed = Object.keys(updates).filter((k) => k !== "updated_at").join(", ");
      return { content: [{ type: "text", text: `Task ${task_id} updated: ${changed}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "add_comment",
  "Add a comment to a task. Use this for code review notes, bug reports, questions, etc.",
  {
    task_id: z.string().describe("The task ID"),
    content: z.string().max(10000).describe("Comment text"),
  },
  async ({ task_id, content }) => {
    try {
      const agent = getAgentName();

      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task '${task_id}' not found.` }] };
      }

      const id = uuid8();
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content) VALUES (?, ?, ?, ?)"
      ).run(id, task_id, agent, content);

      return { content: [{ type: "text", text: `Comment added to task ${task_id} (id: ${id})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "submit_review",
  "Submit a structured review verdict for a task. Records a pass/fail verdict with categorized issues that can be parsed programmatically.",
  {
    task_id: z.string().describe("The task ID to review"),
    verdict: z.enum(["approve", "reject"]).describe("Review verdict"),
    content: z.string().max(10000).describe("Review summary / feedback"),
    categories: z.array(z.string()).default([]).describe("Issue categories, e.g. ['bug', 'style', 'perf', 'security', 'design', 'testing']"),
  },
  async ({ task_id, verdict, content, categories }) => {
    try {
      const agent = getAgentName();

      const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
      }

      const id = uuid8();
      const catsJson = JSON.stringify(categories);
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author, content, type, verdict, categories)
         VALUES (?, ?, ?, ?, 'review', ?, ?)`
      ).run(id, task_id, agent, content, verdict, catsJson);

      return { content: [{ type: "text", text: `Review submitted for ${task_id}: ${verdict.toUpperCase()} (id: ${id})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "set_criteria",
  "Set the acceptance criteria checklist for a task. Replaces any existing criteria. Each item is a checkable requirement.",
  {
    task_id: z.string().describe("The task ID"),
    criteria: z.array(z.string()).describe("List of acceptance criteria text items"),
  },
  async ({ task_id, criteria }) => {
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
);

server.tool(
  "check_criterion",
  "Check or uncheck an acceptance criterion on a task. Use the criterion ID (e.g. 'c1', 'c2') from get_task output.",
  {
    task_id: z.string().describe("The task ID"),
    criterion_id: z.string().describe("The criterion ID (e.g. 'c1')"),
    checked: z.boolean().default(true).describe("true to check, false to uncheck"),
  },
  async ({ task_id, criterion_id, checked }) => {
    try {
      const agent = getAgentName();

      const task = db.prepare("SELECT id, criteria FROM tasks WHERE id = ?").get(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task '${task_id}' not found.` }], isError: true };
      }

      let items;
      try {
        items = JSON.parse(task.criteria || "[]");
      } catch {
        items = [];
      }

      const item = items.find((c) => c.id === criterion_id);
      if (!item) {
        const ids = items.map((c) => c.id).join(", ");
        return { content: [{ type: "text", text: `Criterion '${criterion_id}' not found. Available: ${ids || "none"}` }], isError: true };
      }

      item.checked = checked;
      item.checked_by = checked ? agent : null;

      db.prepare("UPDATE tasks SET criteria = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(items), now(), task_id);

      const done = items.filter((c) => c.checked).length;
      return { content: [{ type: "text", text: `Criterion ${criterion_id} ${checked ? "checked" : "unchecked"} on task ${task_id} (${done}/${items.length} done)` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_board",
  "Get a sprint board overview for a project — tasks grouped by status column.",
  {
    project: z.string().describe("Project name"),
  },
  async ({ project }) => {
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
);

server.tool(
  "add_dependency",
  "Add a dependency between tasks — task_id is blocked by depends_on_id. Rejects self-references and circular dependencies.",
  {
    task_id: z.string().describe("The task that is blocked"),
    depends_on_id: z.string().describe("The task it depends on (must complete first)"),
  },
  async ({ task_id, depends_on_id }) => {
    try {
      const agent = getAgentName();

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
      ).run(task_id, depends_on_id, agent);

      return { content: [{ type: "text", text: `Dependency added: "${t1.title}" is now blocked by "${t2.title}"` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_task",
  "Delete a task and all its comments, dependencies, history, and subtasks. This is irreversible.",
  {
    task_id: z.string().describe("The task ID to delete"),
    confirm: z.boolean().describe("Must be true to confirm deletion"),
  },
  async ({ task_id, confirm }) => {
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
);

server.tool(
  "remove_dependency",
  "Remove a dependency link between two tasks.",
  {
    task_id: z.string().describe("The task that was blocked"),
    depends_on_id: z.string().describe("The dependency to remove"),
  },
  async ({ task_id, depends_on_id }) => {
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
);

// ── Initiatives ──────────────────────────────────────────────────────

server.tool(
  "create_initiative",
  "Create a shared cross-cutting initiative (a goal spanning multiple agents with success criteria and progress tracking). Returns the initiative ID.",
  {
    title: z.string().max(200).describe("Short initiative title"),
    description: z.string().max(10000).default("").describe("Detailed description of the shared goal"),
    participants: z.array(z.string()).default([]).describe("Agent names participating in this initiative"),
    criteria: z.array(z.string()).default([]).describe("Success criteria — what 'done' looks like"),
    target_date: z.string().optional().describe("Target completion date (ISO format)"),
  },
  async ({ title, description, participants, criteria, target_date }) => {
    try {
      const agent = getAgentName();
      const id = uuid8();
      const ts = now();

      db.prepare(
        `INSERT INTO initiatives
         (id, title, description, owner, participating_agents, success_criteria, target_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, title, description, agent, JSON.stringify(participants), JSON.stringify(criteria), target_date || null, ts, ts);

      return { content: [{ type: "text", text: `Initiative created: ${id} — "${title}" (owner: ${agent}, participants: ${participants.join(", ") || "none yet"})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_initiatives",
  "List initiatives with optional filters.",
  {
    status: z.enum(["active", "paused", "completed", "archived", "all"]).default("active").describe("Filter by status"),
    owner: z.string().optional().describe("Filter by owner agent"),
    limit: z.number().min(1).max(100).default(20).describe("Max results"),
  },
  async ({ status, owner, limit }) => {
    try {
      const clauses = [];
      const params = [];

      if (status && status !== "all") { clauses.push("status = ?"); params.push(status); }
      if (owner) { clauses.push("owner = ?"); params.push(owner); }

      let sql = "SELECT * FROM initiatives";
      if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
      sql += " ORDER BY updated_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No initiatives found matching filters." }] };
      }

      const lines = rows.map((i) => {
        const pct = i.progress_pct || 0;
        const target = i.target_date ? ` (target: ${i.target_date})` : "";
        let agents;
        try { agents = JSON.parse(i.participating_agents || "[]"); } catch { agents = []; }
        const agentStr = agents.length ? ` → ${agents.join(", ")}` : "";
        return `${i.id} | [${i.status}] ${pct}% | ${i.title} (owner: ${i.owner})${agentStr}${target}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_initiative",
  "Get full initiative details including linked tasks and recent updates.",
  {
    initiative_id: z.string().describe("The initiative ID"),
  },
  async ({ initiative_id }) => {
    try {
      const initiative = db.prepare("SELECT * FROM initiatives WHERE id = ?").get(initiative_id);
      if (!initiative) {
        return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
      }

      let participants, criteria;
      try { participants = JSON.parse(initiative.participating_agents || "[]"); } catch { participants = []; }
      try { criteria = JSON.parse(initiative.success_criteria || "[]"); } catch { criteria = []; }

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
);

server.tool(
  "update_initiative",
  "Update an initiative's status, progress, description, or other fields.",
  {
    initiative_id: z.string().describe("The initiative ID"),
    status: z.enum(["active", "paused", "completed", "archived"]).optional().describe("New status"),
    progress_pct: z.number().min(0).max(100).optional().describe("Progress percentage (0-100)"),
    description: z.string().optional().describe("Updated description"),
    title: z.string().optional().describe("Updated title"),
    participants: z.array(z.string()).optional().describe("Updated participant list"),
    criteria: z.array(z.string()).optional().describe("Updated success criteria"),
    target_date: z.string().optional().describe("Updated target date"),
  },
  async ({ initiative_id, status, progress_pct, description, title, participants, criteria, target_date }) => {
    try {
      const existing = db.prepare("SELECT id FROM initiatives WHERE id = ?").get(initiative_id);
      if (!existing) {
        return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
      }

      const sets = [];
      const params = [];
      if (status !== undefined) { sets.push("status = ?"); params.push(status); }
      if (progress_pct !== undefined) { sets.push("progress_pct = ?"); params.push(progress_pct); }
      if (description !== undefined) { sets.push("description = ?"); params.push(description); }
      if (title !== undefined) { sets.push("title = ?"); params.push(title); }
      if (participants !== undefined) { sets.push("participating_agents = ?"); params.push(JSON.stringify(participants)); }
      if (criteria !== undefined) { sets.push("success_criteria = ?"); params.push(JSON.stringify(criteria)); }
      if (target_date !== undefined) { sets.push("target_date = ?"); params.push(target_date); }

      if (sets.length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }], isError: true };
      }

      sets.push("updated_at = ?");
      params.push(now());
      params.push(initiative_id);

      db.prepare(`UPDATE initiatives SET ${sets.join(", ")} WHERE id = ?`).run(...params);

      const changes = sets.slice(0, -1).map(s => s.split(" = ")[0]).join(", ");
      return { content: [{ type: "text", text: `Initiative ${initiative_id} updated: ${changes}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "link_task_to_initiative",
  "Link a task to an initiative, describing what role the task plays in the shared goal.",
  {
    initiative_id: z.string().describe("The initiative ID"),
    task_id: z.string().describe("The task ID to link"),
    role: z.string().default("").describe("What this task contributes to the initiative (e.g. 'resume optimization', 'portfolio site')"),
  },
  async ({ initiative_id, task_id, role }) => {
    try {
      const agent = getAgentName();

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
      ).run(id, initiative_id, task_id, role, agent, now());

      return { content: [{ type: "text", text: `Task "${task.title}" linked to initiative "${initiative.title}"${role ? ` (role: ${role})` : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "add_initiative_update",
  "Log a progress note on an initiative. Use this to record milestones, blockers, or status changes.",
  {
    initiative_id: z.string().describe("The initiative ID"),
    update_text: z.string().max(5000).describe("Progress note or status update"),
  },
  async ({ initiative_id, update_text }) => {
    try {
      const agent = getAgentName();

      const initiative = db.prepare("SELECT id, title FROM initiatives WHERE id = ?").get(initiative_id);
      if (!initiative) {
        return { content: [{ type: "text", text: `Initiative '${initiative_id}' not found.` }], isError: true };
      }

      const id = uuid8();
      db.prepare(
        `INSERT INTO initiative_updates (id, initiative_id, agent_name, update_text, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, initiative_id, agent, update_text, now());

      return { content: [{ type: "text", text: `Update logged on "${initiative.title}": ${update_text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
