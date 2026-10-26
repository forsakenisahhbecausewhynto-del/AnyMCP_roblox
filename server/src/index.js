
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HttpError,
  RateLimiter,
  boundedString,
  clientKey,
  jsonHeaders,
  publicError,
  readJsonBody,
  safeTokenEqual,
  validateHeartbeat,
  validateResult
} from "./security.js";
import { HEALTH_STATES, HealthController } from "./recovery.js";
import { prepareRepairProposal } from "./repair.js";

const HOST = process.env.ANYMCP_HOST || "127.0.0.1";
const PORT = Number(process.env.ANYMCP_PORT || 39271);
const TOKEN = process.env.ANYMCP_TOKEN || randomUUID();
const MAX_PENDING = 50;
const MAX_QUEUE = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const REPAIR_DIR = process.env.ANYMCP_REPAIR_DIR || join(process.cwd(), ".anymcp-repairs");
const pending = new Map();
const queue = [];
let lastHeartbeat = 0;
let studioInfo = {};
const authLimiter = new RateLimiter({
  limit: Number(process.env.ANYMCP_AUTH_LIMIT || 10),
  windowMs: 60_000
});
const requestLimiter = new RateLimiter({
  limit: Number(process.env.ANYMCP_REQUEST_LIMIT || 120),
  windowMs: 60_000
});
const health = new HealthController({
  enabled: process.env.ANYMCP_AUTO_RECOVERY !== "0",
  cleanupExpired: cleanupExpiredRequests
});

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("ANYMCP_PORT must be an integer between 1 and 65535.");
}

console.error("AnyMCP local bridge token:", TOKEN);
console.error("Configure the Studio plugin with this same token.");

function send(res, status, value) {
  res.writeHead(status, {
    ...jsonHeaders(),
    "Access-Control-Allow-Origin": "http://localhost",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-AnyMCP-Token"
  });
  res.end(JSON.stringify(value));
}

function studioOnline() {
  return Date.now() - lastHeartbeat < 20_000;
}

function cleanupExpiredRequests() {
  let removed = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (!pending.has(queue[index].id)) {
      queue.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

function askStudio(action, args = {}) {
  if (health.state === HEALTH_STATES.SAFE_MODE) {
    throw new Error("Server is in safe mode; Studio operations are temporarily disabled.");
  }
  if (!studioOnline()) {
    throw new Error("Roblox Studio is offline. Open the AnyMCP Studio plugin.");
  }
  if (pending.size >= MAX_PENDING || queue.length >= MAX_QUEUE) {
    throw new Error("Too many pending Studio requests.");
  }

  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const queueIndex = queue.findIndex(command => command.id === id);
      if (queueIndex !== -1) queue.splice(queueIndex, 1);
      reject(new Error("Studio request timed out."));
      health.recordTimeout();
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, {
      resolve: value => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

    queue.push({ id, action, args });
  });
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const key = clientKey(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...jsonHeaders(),
        "Access-Control-Allow-Origin": "http://localhost",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-AnyMCP-Token"
      });
      return res.end();
    }

    if (!authLimiter.allow(key)) {
      return send(res, 429, { error: "Too many authentication attempts.", code: "rate_limited" });
    }

    if (!safeTokenEqual(req.headers["x-anymcp-token"], TOKEN)) {
      health.recordAuthenticationFailure();
      return send(res, 401, { error: "Unauthorized.", code: "unauthorized" });
    }

    if (!requestLimiter.allow(key)) {
      return send(res, 429, { error: "Too many requests.", code: "rate_limited" });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        studioConnected: studioOnline(),
        studio: studioInfo,
        health: health.status({
          studioConnected: studioOnline(),
          lastHeartbeat: lastHeartbeat || null,
          pending: pending.size,
          queued: queue.length
        })
      });
    }

    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const data = validateHeartbeat(await readJsonBody(req));
      lastHeartbeat = Date.now();
      studioInfo = data;
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/next") {
      return send(res, 200, { command: queue.shift() || null });
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const rawData = await readJsonBody(req);
      const data = validateResult(rawData);
      const item = pending.get(data.id);

      if (!item) {
        return send(res, 404, { error: "Unknown or expired request" });
      }

      if (rawData.error) {
        item.reject(new Error(rawData.error));
      } else {
        item.resolve(rawData.result);
      }

      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/diagnostics") {
      return send(res, 200, health.status({
        studioConnected: studioOnline(),
        lastHeartbeat: lastHeartbeat || null,
        pending: pending.size,
        queued: queue.length
      }));
    }

    if (req.method === "POST" && url.pathname === "/recover") {
      const data = await readJsonBody(req);
      const action = boundedString(data.action || "", "action", 100);
      return send(res, action === "cleanup_expired" ? 200 : 400, await health.recover(action));
    }

    if (req.method === "POST" && url.pathname === "/repair/proposal") {
      const data = await readJsonBody(req);
      const summary = boundedString(data.summary || "", "summary", 1_000);
      const patch = boundedString(data.patch || "", "patch", 50_000);
      const proposal = await prepareRepairProposal({
        directory: REPAIR_DIR,
        summary,
        patch
      });
      health.codeRepairPending = true;
      return send(res, 202, {
        id: proposal.id,
        status: proposal.status,
        approvalRequired: true
      });
    }

    if (["/health", "/heartbeat", "/next", "/result", "/diagnostics", "/recover", "/repair/proposal"].includes(url.pathname)) {
      return send(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
    }

    return send(res, 404, { error: "Not found.", code: "not_found" });
  } catch (error) {
    const result = publicError(error);
    if (result.status >= 500) health.recordServerError();
    return send(res, result.status, result.body);
  }
});

httpServer.on("error", error => {
  health.recordServerError();
  if (error.code === "EADDRINUSE") {
    console.error(`AnyMCP HTTP bridge could not bind to ${HOST}:${PORT}: port is already in use.`);
  } else {
    console.error("AnyMCP HTTP bridge failed to bind safely.");
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`AnyMCP bridge listening on ${HOST}:${PORT}`);
});

const recoveryTimer = setInterval(() => {
  if (health.enabled && queue.length > 0) health.recover("cleanup_expired");
}, 30_000);
recoveryTimer.unref();

const mcp = new McpServer({
  name: "anymcp-roblox",
  version: "0.1.0"
});

mcp.tool(
  "studio_status",
  "Check whether Roblox Studio is connected.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        connected: studioOnline(),
        studio: studioInfo
      })
    }]
  })
);

mcp.tool(
  "get_game_tree",
  "Read a bounded summary of the current Roblox game hierarchy.",
  {
    path: z.string().optional().describe(
      "Optional starting path, such as game.Workspace"
    )
  },
  async ({ path }) => {
    const result = await askStudio("get_game_tree", {
      path: path || "game",
      maxDepth: 4,
      maxItems: 200
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

mcp.tool(
  "get_selection",
  "Read the current Roblox Studio selection.",
  {},
  async () => {
    const result = await askStudio("get_selection");

    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

await mcp.connect(new StdioServerTransport());
