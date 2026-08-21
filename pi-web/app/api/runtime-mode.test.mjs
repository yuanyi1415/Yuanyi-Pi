import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const previous = {
  gateway: process.env.PERSONAL_GATEWAY_ENABLED,
  legacy: process.env.ALLOW_LEGACY_RPC_RUNTIME,
  gatewayUrl: process.env.PERSONAL_GATEWAY_URL,
};
process.env.PERSONAL_GATEWAY_ENABLED = "0";
process.env.ALLOW_LEGACY_RPC_RUNTIME = "0";
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./agent/new/route.ts");

test("Gateway 未启用且未显式允许 legacy 时 fail closed", async () => {
  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    body: JSON.stringify({ type: "ensure_session" }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "runtime_unavailable",
    message: "Personal Runtime/Gateway is unavailable",
  });
});

test("S6-05: Gateway 启用但不可达 → 503 runtime_unavailable，不得 fallback", async () => {
  process.env.PERSONAL_GATEWAY_ENABLED = "1";
  process.env.ALLOW_LEGACY_RPC_RUNTIME = "0";
  // 指向不可能监听的端口（连接失败 → gatewayFetch 抛 status:503）
  process.env.PERSONAL_GATEWAY_URL = "http://127.0.0.1:9";
  const jitiDown = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const { POST: POSTDown } = await jitiDown.import("./agent/new/route.ts");
  const response = await POSTDown(new Request("http://localhost/api/agent/new", {
    method: "POST",
    body: JSON.stringify({ type: "prompt", message: "hi" }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "runtime_unavailable");
  assert.equal(body.accepted, false);
});

test.after(() => {
  if (previous.gateway === undefined) delete process.env.PERSONAL_GATEWAY_ENABLED;
  else process.env.PERSONAL_GATEWAY_ENABLED = previous.gateway;
  if (previous.legacy === undefined) delete process.env.ALLOW_LEGACY_RPC_RUNTIME;
  else process.env.ALLOW_LEGACY_RPC_RUNTIME = previous.legacy;
  if (previous.gatewayUrl === undefined) delete process.env.PERSONAL_GATEWAY_URL;
  else process.env.PERSONAL_GATEWAY_URL = previous.gatewayUrl;
});
