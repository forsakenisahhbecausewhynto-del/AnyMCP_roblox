
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HOST = process.env.ANYMCP_HOST || "127.0.0.1";
const PORT = Number(process.env.ANYMCP_PORT || 39271);
const TOKEN = process.env.ANYMCP_TOKEN || randomUUID();
const MAX_PENDING = 50;
const MAX_QUEUE = 50;
const pending = new Map();
const queue = [];
let lastHeartbeat = 0;
let studioInfo = {};

console.error("AnyMCP local bridge token:", TOKEN);
console.error("Configure the Studio plugin with this same token.");

function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-AnyMCP-Token"
  });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

function studioOnline() {
  return Date.now() - lastHeartbeat < 20_000;
}

function askStudio(action, args = {}) {
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
    }, 10_000);

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
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "http://localhost",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-AnyMCP-Token"
      });
      return res.end();
    }

    if (req.headers["x-anymcp-token"] !== TOKEN) {
      return send(res, 401, { error: "Unauthorized" });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        studioConnected: studioOnline(),
        studio: studioInfo
      });
    }

    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const data = await readBody(req);
      lastHeartbeat = Date.now();
      studioInfo = {
        placeName: String(data.placeName || "").slice(0, 200),
        gameId: String(data.gameId || "").slice(0, 100)
      };
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/next") {
      return send(res, 200, { command: queue.shift() || null });
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const data = await readBody(req);
      const item = pending.get(String(data.id));

      if (!item) {
        return send(res, 404, { error: "Unknown or expired request" });
      }

      if (data.error) {
        item.reject(new Error(String(data.error).slice(0, 1000)));
      } else {
        item.resolve(data.result);
      }

      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 400, { error: error.message || "Bad request" });
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`AnyMCP bridge listening on ${HOST}:${PORT}`);
});

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
