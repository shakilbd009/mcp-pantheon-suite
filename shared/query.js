/**
 * Shared query-building and JSON-parsing utilities for MCP servers.
 */

/**
 * Build a WHERE clause from an array of filter objects.
 * @param {Array<{column: string, value: any, op?: string}>} filters
 * @returns {{ sql: string, params: any[] }}
 */
export function buildWhereClause(filters) {
  if (!filters || filters.length === 0) return { sql: "", params: [] };

  const parts = [];
  const params = [];
  for (const f of filters) {
    const op = f.op || "=";
    parts.push(`${f.column} ${op} ?`);
    params.push(f.value);
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * Build a SET clause from a plain object of column:value pairs.
 * @param {Record<string, any>} updates
 * @returns {{ sql: string, params: any[] }}
 */
export function buildSetClause(updates) {
  if (!updates) return { sql: "", params: [] };

  const keys = Object.keys(updates);
  if (keys.length === 0) return { sql: "", params: [] };

  const parts = [];
  const params = [];
  for (const key of keys) {
    parts.push(`${key} = ?`);
    params.push(updates[key]);
  }
  return { sql: parts.join(", "), params };
}

/**
 * Safely parse a JSON string, returning a default value on failure.
 * Logs a warning via console.error on parse failure or type mismatch.
 * @param {any} str - The string to parse
 * @param {any} defaultValue - Value to return on failure
 * @param {string} context - Label for warning messages
 * @returns {any}
 */
export function safeJsonParse(str, defaultValue, context) {
  if (str == null || typeof str !== "string") return defaultValue;

  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    console.error(`[warn] ${context}: invalid JSON — ${str.slice(0, 80)}`);
    return defaultValue;
  }

  if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
    console.error(`[warn] ${context}: expected array but got ${typeof parsed}`);
    return defaultValue;
  }

  return parsed;
}
