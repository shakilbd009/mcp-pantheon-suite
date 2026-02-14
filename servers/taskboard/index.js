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
import { createDb, getAgentName } from "../../shared/db.js";
import {
  initSchema,
  VALID_STATUSES,
  createTask,
  listTasks,
  searchTasks,
  getTask,
  updateTask,
  addComment,
  submitReview,
  setCriteria,
  checkCriterion,
  getBoard,
  addDependency,
  deleteTask,
  removeDependency,
  createInitiative,
  listInitiatives,
  getInitiative,
  updateInitiative,
  linkTaskToInitiative,
  addInitiativeUpdate,
} from "./handlers.js";

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
  async (params) => createTask(db, getAgentName(), params)
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
  async (params) => listTasks(db, getAgentName(), params)
);

server.tool(
  "search_tasks",
  "Full-text search across all tasks by title and description.",
  {
    query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, prefix*)"),
    limit: z.number().min(1).max(100).default(20).describe("Max results"),
  },
  async (params) => searchTasks(db, getAgentName(), params)
);

server.tool(
  "get_task",
  "Get full details of a task including its comment thread.",
  {
    task_id: z.string().describe("The task ID"),
  },
  async (params) => getTask(db, getAgentName(), params)
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
  async (params) => updateTask(db, getAgentName(), params)
);

server.tool(
  "add_comment",
  "Add a comment to a task. Use this for code review notes, bug reports, questions, etc.",
  {
    task_id: z.string().describe("The task ID"),
    content: z.string().max(10000).describe("Comment text"),
  },
  async (params) => addComment(db, getAgentName(), params)
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
  async (params) => submitReview(db, getAgentName(), params)
);

server.tool(
  "set_criteria",
  "Set the acceptance criteria checklist for a task. Replaces any existing criteria. Each item is a checkable requirement.",
  {
    task_id: z.string().describe("The task ID"),
    criteria: z.array(z.string()).describe("List of acceptance criteria text items"),
  },
  async (params) => setCriteria(db, getAgentName(), params)
);

server.tool(
  "check_criterion",
  "Check or uncheck an acceptance criterion on a task. Use the criterion ID (e.g. 'c1', 'c2') from get_task output.",
  {
    task_id: z.string().describe("The task ID"),
    criterion_id: z.string().describe("The criterion ID (e.g. 'c1')"),
    checked: z.boolean().default(true).describe("true to check, false to uncheck"),
  },
  async (params) => checkCriterion(db, getAgentName(), params)
);

server.tool(
  "get_board",
  "Get a sprint board overview for a project — tasks grouped by status column.",
  {
    project: z.string().describe("Project name"),
  },
  async (params) => getBoard(db, getAgentName(), params)
);

server.tool(
  "add_dependency",
  "Add a dependency between tasks — task_id is blocked by depends_on_id. Rejects self-references and circular dependencies.",
  {
    task_id: z.string().describe("The task that is blocked"),
    depends_on_id: z.string().describe("The task it depends on (must complete first)"),
  },
  async (params) => addDependency(db, getAgentName(), params)
);

server.tool(
  "delete_task",
  "Delete a task and all its comments, dependencies, history, and subtasks. This is irreversible.",
  {
    task_id: z.string().describe("The task ID to delete"),
    confirm: z.boolean().describe("Must be true to confirm deletion"),
  },
  async (params) => deleteTask(db, getAgentName(), params)
);

server.tool(
  "remove_dependency",
  "Remove a dependency link between two tasks.",
  {
    task_id: z.string().describe("The task that was blocked"),
    depends_on_id: z.string().describe("The dependency to remove"),
  },
  async (params) => removeDependency(db, getAgentName(), params)
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
  async (params) => createInitiative(db, getAgentName(), params)
);

server.tool(
  "list_initiatives",
  "List initiatives with optional filters.",
  {
    status: z.enum(["active", "paused", "completed", "archived", "all"]).default("active").describe("Filter by status"),
    owner: z.string().optional().describe("Filter by owner agent"),
    limit: z.number().min(1).max(100).default(20).describe("Max results"),
  },
  async (params) => listInitiatives(db, getAgentName(), params)
);

server.tool(
  "get_initiative",
  "Get full initiative details including linked tasks and recent updates.",
  {
    initiative_id: z.string().describe("The initiative ID"),
  },
  async (params) => getInitiative(db, getAgentName(), params)
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
  async (params) => updateInitiative(db, getAgentName(), params)
);

server.tool(
  "link_task_to_initiative",
  "Link a task to an initiative, describing what role the task plays in the shared goal.",
  {
    initiative_id: z.string().describe("The initiative ID"),
    task_id: z.string().describe("The task ID to link"),
    role: z.string().default("").describe("What this task contributes to the initiative (e.g. 'resume optimization', 'portfolio site')"),
  },
  async (params) => linkTaskToInitiative(db, getAgentName(), params)
);

server.tool(
  "add_initiative_update",
  "Log a progress note on an initiative. Use this to record milestones, blockers, or status changes.",
  {
    initiative_id: z.string().describe("The initiative ID"),
    update_text: z.string().max(5000).describe("Progress note or status update"),
  },
  async (params) => addInitiativeUpdate(db, getAgentName(), params)
);

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
