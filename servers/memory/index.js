#!/usr/bin/env node
/**
 * MCP Memory Server — structured long-term memory for AI agents.
 *
 * Store observations, learnings, facts, patterns, and preferences
 * that persist across sessions. Memories are tagged for retrieval
 * and ranked by importance.
 *
 * Memory types: fact, learning, preference, observation, pattern
 *
 * Tools:
 *   - store_memory: Save a new memory with tags and importance
 *   - recall: Search memories by tags, text query, and/or type
 *   - list_memories: List all your memories
 *   - forget: Delete a memory by ID
 *   - update_memory: Update an existing memory's content or importance
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDb, getAgentName } from "../../shared/db.js";
import {
  initSchema,
  MEMORY_TYPES,
  storeMemory,
  recall,
  listMemories,
  forget,
  updateMemory,
} from "./handlers.js";

// ── Init ─────────────────────────────────────────────────────────────

const db = createDb("memory");
initSchema(db);

const server = new McpServer({
  name: "mcp-memory",
  version: "1.0.0",
});

// ── Tools ────────────────────────────────────────────────────────────

server.tool(
  "store_memory",
  `Store a new memory. Use this to remember important information across sessions.

Memory types:
- fact: Concrete information ("staging server IP is 10.0.1.5")
- learning: Something you learned from experience ("retrying after 30s fixes the flaky test")
- preference: User or system preferences ("user prefers concise reports")
- observation: Something you noticed ("email queue backs up on Mondays")
- pattern: Recurring patterns you've identified ("deploy failures correlate with high DB load")

Tips:
- Use descriptive tags for easy retrieval later
- Set higher importance (7-10) for critical operational knowledge
- Set lower importance (1-4) for nice-to-know observations`,
  {
    content: z.string().max(10000).describe("The memory content — be specific and actionable"),
    memory_type: z.enum(MEMORY_TYPES).default("observation").describe("Type of memory"),
    tags: z.array(z.string().max(50)).min(1).max(10).describe("Tags for retrieval (e.g. ['deploy', 'staging', 'error'])"),
    importance: z.number().int().min(1).max(10).default(5).describe("Importance 1-10 (10 = critical operational knowledge)"),
  },
  async (params) => storeMemory(db, getAgentName(), params)
);

server.tool(
  "recall",
  "Search your memories by tags, text query, and/or type. Returns memories ranked by importance. Use this to recall what you know about a topic before taking action.",
  {
    query: z.string().optional().describe("Text search within memory content"),
    tags: z.array(z.string()).optional().describe("Filter by any of these tags"),
    memory_type: z.enum([...MEMORY_TYPES, "any"]).default("any").describe("Filter by memory type"),
    limit: z.number().int().min(1).max(30).default(10).describe("Max results"),
  },
  async (params) => recall(db, getAgentName(), params)
);

server.tool(
  "list_memories",
  "List all your memories, optionally filtered by type. Shows a summary of each memory.",
  {
    memory_type: z.enum([...MEMORY_TYPES, "any"]).default("any").describe("Filter by type"),
    limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  },
  async (params) => listMemories(db, getAgentName(), params)
);

server.tool(
  "forget",
  "Delete a memory by ID. Use when a memory is outdated or incorrect.",
  {
    memory_id: z.string().describe("The memory ID to delete"),
  },
  async (params) => forget(db, getAgentName(), params)
);

server.tool(
  "update_memory",
  "Update an existing memory's content, importance, or tags. Use to correct or enhance a memory.",
  {
    memory_id: z.string().describe("The memory ID to update"),
    content: z.string().max(10000).optional().describe("New content"),
    importance: z.number().int().min(1).max(10).optional().describe("New importance (1-10)"),
    tags: z.array(z.string().max(50)).optional().describe("New tags (replaces existing)"),
  },
  async (params) => updateMemory(db, getAgentName(), params)
);

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
