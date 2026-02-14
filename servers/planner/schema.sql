-- MCP Planner Server — Reference Schema
-- Tables are auto-created by the server on first run.
-- This file is for documentation only.

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  title TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  progress TEXT DEFAULT '0/0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_name);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(agent_name, status);
