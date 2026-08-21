import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/index";

test("loadConfig rejects dev paths and port in prod", () => {
  assert.throws(
    () => loadConfig({
      YUANYI_RUNTIME_ENV: "prod",
      YUANYI_PI_DATA_DIR: "/tmp/.pi-dev/runtime",
      YUANYI_PI_AGENT_DIR: "/tmp/.pi/agent",
      YUANYI_PI_PORT: "8770",
    }),
    /Production runtime contains development configuration/,
  );
  assert.throws(
    () => loadConfig({
      YUANYI_RUNTIME_ENV: "prod",
      YUANYI_PI_DATA_DIR: "/tmp/yuanyi-pi",
      YUANYI_PI_AGENT_DIR: "/tmp/.pi/agent",
      YUANYI_PI_PORT: "8771",
    }),
    /Production runtime contains development configuration/,
  );
});

test("loadConfig keeps launcher environment values separate", () => {
  const config = loadConfig({
    YUANYI_RUNTIME_ENV: "dev",
    YUANYI_PI_DATA_DIR: "/tmp/yuanyi-pi-dev",
    YUANYI_PI_AGENT_DIR: "/tmp/.pi-dev/agent",
    YUANYI_PI_PORT: "8771",
  });
  assert.equal(config.runtimeEnv, "dev");
  assert.equal(config.port, 8771);
  assert.equal(config.agentDir, "/tmp/.pi-dev/agent");
});
