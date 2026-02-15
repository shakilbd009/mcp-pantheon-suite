/**
 * Integration test harness for MCP servers.
 *
 * Spawns MCP servers as child processes, communicates via JSON-RPC 2.0
 * over stdin/stdout, and manages temp DB lifecycle.
 *
 * Usage:
 *   const h = await spawn("servers/memory/index.js");
 *   const tools = await h.listTools();
 *   const result = await h.callTool("store_memory", { content: "hi", tags: ["test"] });
 *   await h.close();
 */
import { spawn as cpSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INIT_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 5000;

/**
 * Spawn an MCP server subprocess and complete the initialization handshake.
 *
 * @param {string} serverPath - Relative path to server entry point (e.g. "servers/memory/index.js")
 * @param {object} [opts]
 * @param {string} [opts.agentName] - MCP_AGENT_NAME env var (default: "test-agent")
 * @param {string} [opts.dbPath] - Override MCP_DB_PATH (default: auto temp dir)
 * @returns {Promise<{callTool, listTools, close}>}
 */
export async function spawn(serverPath, opts = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const dbPath = opts.dbPath || join(tmpDir, "test.db");
  const agentName = opts.agentName || "test-agent";

  const proc = cpSpawn("node", [serverPath], {
    cwd: join(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      MCP_DB_PATH: dbPath,
      MCP_AGENT_NAME: agentName,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let requestId = 0;
  const pending = new Map(); // id → { resolve, reject, timer }
  let buffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip non-JSON lines (e.g. console.error output)
      }

      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  // Collect stderr for debugging
  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function request(method, params = {}) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id}). stderr: ${stderrBuf.slice(-500)}`));
      }, CALL_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // --- Initialize handshake ---
  const initResponse = await Promise.race([
    request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Init handshake timed out after ${INIT_TIMEOUT_MS}ms. stderr: ${stderrBuf.slice(-500)}`)), INIT_TIMEOUT_MS)
    ),
  ]);

  if (initResponse.error) {
    throw new Error(`MCP init error: ${JSON.stringify(initResponse.error)}`);
  }

  // Send initialized notification (no id — it's a notification)
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // --- Public API ---
  return {
    /** The raw child process */
    process: proc,

    /** The temp DB path */
    dbPath,

    /** Server capabilities from init response */
    serverInfo: initResponse.result,

    /**
     * Call an MCP tool and return the result content array.
     * @param {string} name - Tool name
     * @param {object} args - Tool arguments
     * @returns {Promise<Array<{type: string, text: string}>>}
     */
    async callTool(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      if (response.error) {
        throw new Error(`Tool call error (${name}): ${JSON.stringify(response.error)}`);
      }
      return response.result;
    },

    /**
     * List all registered tool names.
     * @returns {Promise<string[]>}
     */
    async listTools() {
      const response = await request("tools/list", {});
      if (response.error) {
        throw new Error(`listTools error: ${JSON.stringify(response.error)}`);
      }
      return response.result.tools.map((t) => t.name);
    },

    /**
     * Kill the server process and clean up temp files.
     */
    async close() {
      // Clear any pending promises
      for (const [id, { reject, timer }] of pending) {
        clearTimeout(timer);
        reject(new Error("Harness closed"));
      }
      pending.clear();

      proc.kill("SIGTERM");

      // Wait for exit (max 2s)
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 2000);
        proc.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });

      // Clean up temp directory
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
