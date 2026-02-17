/**
 * Re-exports all taskboard handlers for backward compatibility.
 * Import from this file to get all handlers in one place.
 */
export {
  initSchema,
  FORGE_STATUSES,
  FORGE_TRANSITIONS,
  OPS_STATUSES,
  OPS_TRANSITIONS,
  VALID_STATUSES,
  getTransitions,
  getDefaultStatus,
} from "./schema.js";

export {
  createTask,
  listTasks,
  searchTasks,
  getTask,
  updateTask,
  deleteTask,
} from "./tasks.js";

export { addComment, submitReview } from "./comments.js";

export { setCriteria, checkCriterion } from "./criteria.js";

export { getBoard } from "./projects.js";

export { addDependency, removeDependency } from "./dependencies.js";

export {
  createInitiative,
  listInitiatives,
  getInitiative,
  updateInitiative,
  linkTaskToInitiative,
  addInitiativeUpdate,
} from "./initiatives.js";
