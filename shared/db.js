/**
 * Shared SQLite database utilities for MCP servers.
 *
 * Each server calls createDb(serverName) to get a connection to its own
 * SQLite database file. Default location: ~/.mcp-suite/<serverName>.db
 * Override with MCP_DB_PATH environment variable.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

let _db = null;

/**
 * Create (or return cached) SQLite database connection.
 * @param {string} serverName - Used to derive default DB filename
 * @returns {import('better-sqlite3').Database}
 */
export function createDb(serverName) {
  if (_db) return _db;

  const dbPath = process.env.MCP_DB_PATH || join(homedir(), ".mcp-suite", `${serverName}.db`);
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath, { readonly: false });
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  return _db;
}

/**
 * Get the agent name from environment, defaulting to "default".
 * @returns {string}
 */
export function getAgentName() {
  return process.env.MCP_AGENT_NAME || "default";
}

/**
 * Generate an 8-character UUID prefix.
 * @returns {string}
 */
export function uuid8() {
  return randomUUID().slice(0, 8);
}

/**
 * Current time as ISO 8601 string.
 * @returns {string}
 */
export function now() {
  return new Date().toISOString();
}
