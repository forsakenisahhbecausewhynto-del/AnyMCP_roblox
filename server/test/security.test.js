import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { HealthController, HEALTH_STATES } from "../src/recovery.js";
import { RateLimiter, safeTokenEqual } from "../src/security.js";
import { prepareRepairProposal, requireApprovedProposal } from "../src/repair.js";

const port = 39273;
const token = "test-token-for-suite";
const baseUrl = `http://127.0.0.1:${port}`;
let server;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(`AnyMCP bridge listening on 127.0.0.1:${port}`)) {
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", code => reject(new Error(`server exited: ${code}\n${output}`)));
  });
}

test.before(async () => {
  server = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ANYMCP_HOST: "127.0.0.1",
      ANYMCP_PORT: String(port),
      ANYMCP_TOKEN: token,
      ANYMCP_AUTH_LIMIT: "100",
      ANYMCP_AUTO_RECOVERY: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  await waitForServer(server);
});

test.after(() => server?.kill("SIGTERM"));

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

function auth(options = {}) {
  return {
    ...options,
    headers: {
      "X-AnyMCP-Token": token,
      ...(options.headers || {})
    }
  };
}

test("all API routes reject missing credentials", async () => {
  const routes = [
    ["/health", "GET"],
    ["/next", "GET"],
    ["/diagnostics", "GET"],
    ["/heartbeat", "POST"],
    ["/result", "POST"],
    ["/recover", "POST"],
    ["/repair/proposal", "POST"]
  ];

  for (const [path, method] of routes) {
    const response = await request(path, { method });
    assert.equal(response.status, 401, path);
  }
});

test("invalid credentials are rejected without revealing server state", async () => {
  const response = await request("/health", {
    headers: { "X-AnyMCP-Token": "wrong-token" }
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Unauthorized.",
    code: "unauthorized"
  });
});

test("health succeeds with the correct token and exposes bounded status", async () => {
  const response = await request("/health", auth());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.health.safeMode, false);
  assert.equal(typeof body.health.metrics.authenticationFailures, "number");
});

test("malformed, wrong content type, and oversized bodies are rejected", async () => {
  const wrongType = await request("/heartbeat", auth({
    method: "POST",
    body: "{}"
  }));
  assert.equal(wrongType.status, 415);

  const malformed = await request("/heartbeat", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  }));
  assert.equal(malformed.status, 400);

  const oversized = await request("/heartbeat", auth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ placeName: "x".repeat(100_001) })
  }));
  assert.equal(oversized.status, 413);
});

test("methods and paths are validated", async () => {
  const method = await request("/health", auth({ method: "POST" }));
  assert.equal(method.status, 405);
  const path = await request("/not-an-endpoint", auth());
  assert.equal(path.status, 404);
});

test("repair proposals require approval and cannot contain execution primitives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anymcp-repair-"));
  try {
    const proposal = await prepareRepairProposal({
      directory,
      summary: "test proposal",
      patch: "diff --git a/example b/example\n+safe"
    });
    assert.equal(proposal.status, "pending_approval");
    const contents = await readFile(proposal.file, "utf8");
    assert.match(contents, /PENDING APPROVAL/);
    assert.throws(() => requireApprovedProposal(proposal), /explicit maintainer approval/);
    await assert.rejects(
      prepareRepairProposal({ directory, summary: "bad", patch: "eval('bad')" }),
      /prohibited operation/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("security primitives and recovery transitions are bounded", async () => {
  assert.equal(safeTokenEqual(token, token), true);
  assert.equal(safeTokenEqual(token, "wrong"), false);
  assert.equal(safeTokenEqual(token, `${token}x`), false);

  const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);

  const controller = new HealthController({ enabled: true, cleanupExpired: () => 2 });
  for (let index = 0; index < 5; index += 1) controller.recordServerError();
  assert.equal(controller.state, HEALTH_STATES.SAFE_MODE);
  assert.equal((await controller.recover("unknown")).ok, false);
  assert.equal((await controller.recover("cleanup_expired")).ok, false);

  const recoverable = new HealthController({ enabled: true, cleanupExpired: () => 2 });
  assert.deepEqual(await recoverable.recover("cleanup_expired"), { ok: true, removed: 2 });
});

test("plugin keeps URL and token safeguards", async () => {
  const plugin = await readFile(
    new URL("../../studio-plugin/AnyMCPPlugin.lua", import.meta.url),
    "utf8"
  );
  assert.match(plugin, /\^http:\/\/\(\[%w%.%-\]\+\):\(%d\+\)\$/);
  assert.match(plugin, /\^https:\/\/\(\[%w\]\[\%w%-\]\*\)%.app%.github%.dev\$/);
  assert.match(plugin, /\["X-AnyMCP-Token"\] = token/);
  assert.doesNotMatch(plugin, /loadstring|load\s*\(|setfenv|require\s*\(/);
  assert.doesNotMatch(plugin, /SetSetting\(["']token/);
});
