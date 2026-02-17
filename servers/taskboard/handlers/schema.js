/**
 * Schema initialization and pipeline constants.
 */

export function initSchema(db) {
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

export const FORGE_STATUSES = [
  "backlog", "specced", "designed", "ready", "in_progress",
  "in_review", "testing", "acceptance", "done",
];

export const FORGE_TRANSITIONS = {
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

export const OPS_STATUSES = ["todo", "in_progress", "blocked", "done"];

export const OPS_TRANSITIONS = {
  todo: ["in_progress"],
  in_progress: ["blocked", "done"],
  blocked: ["in_progress"],
  done: [],
};

export const VALID_STATUSES = [...new Set([...FORGE_STATUSES, ...OPS_STATUSES])];

export function getTransitions(project) {
  if (project && project.startsWith("ops/")) {
    return OPS_TRANSITIONS;
  }
  return FORGE_TRANSITIONS;
}

export function getDefaultStatus(project) {
  if (project && project.startsWith("ops/")) {
    return "todo";
  }
  return "backlog";
}
