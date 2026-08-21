import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const previous = {
  gateway: process.env.PERSONAL_GATEWAY_ENABLED,
  legacy: process.env.ALLOW_LEGACY_RPC_RUNTIME,
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

test.after(() => {
  if (previous.gateway === undefined) delete process.env.PERSONAL_GATEWAY_ENABLED;
  else process.env.PERSONAL_GATEWAY_ENABLED = previous.gateway;
  if (previous.legacy === undefined) delete process.env.ALLOW_LEGACY_RPC_RUNTIME;
  else process.env.ALLOW_LEGACY_RPC_RUNTIME = previous.legacy;
});
