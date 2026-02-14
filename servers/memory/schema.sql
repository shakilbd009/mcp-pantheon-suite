-- MCP Memory Server — Reference Schema
-- Tables are auto-created by the server on first run.
-- This file is for documentation only.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'observation',
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 5,
  access_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(agent_name, memory_type);
