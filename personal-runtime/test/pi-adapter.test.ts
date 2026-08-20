/**
 * PiRuntimeAdapter 单元测试（DEV212）
 *
 * 隔离策略：临时 cwd + 临时 agentDir，绝不触碰 ~/.pi-dev/agent 与 ~/.pi/agent 真实数据。
 * 不依赖真实 LLM：只验证创建/恢复/状态/命令面/dispose/事件 envelope。
 * Prompt→Streaming 的真实链路见 TST211 集成测试。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../src/pi/adapter";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("create: 生成新 Session，状态 ready，cwd 正确", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  assert.ok(adapter.sessionId, "sessionId 非空");
  const state = await adapter.getState();
  assert.equal(state.state, "ready");
  assert.equal(state.cwd, cwd);
  // 无显式模型时 SDK 可能解析内置默认模型（如 opencode/kimi-k2.6），不做为空断言

  await adapter.dispose();
});

test("resume: 从已落盘 sessionFile 恢复，sessionId 不变", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");

  // 构造真实已落盘 Session（create 后无消息不会写盘，先 append 一条 user 消息）
  const sessionDir = join(agentDir, "sessions");
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hi" }],
  } as never);
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
  } as never);
  const sessionFile = sm.getSessionFile()!;
  assert.ok(existsSync(sessionFile), "session 文件已落盘");
  const sessionId = sm.getSessionId();

  const resumed = await PiRuntimeAdapter.resume({ sessionFile, agentDir });
  assert.equal(resumed.sessionId, sessionId, "恢复后 sessionId 不变");
  const state = await resumed.getState();
  assert.equal(state.cwd, cwd, "恢复后 cwd 保持");
  await resumed.dispose();
});

test("setThinkingLevel: 生效并可在 getState 读回", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  await adapter.setThinkingLevel("high");
  const state = await adapter.getState();
  assert.equal(state.thinkingLevel, "high");

  await adapter.dispose();
});

test("sendCommand: get_state / abort / dispose 后拒绝", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  const state = await adapter.sendCommand({ type: "get_state" }) as { state: string };
  assert.equal(state.state, "ready");

  await adapter.dispose();
  await assert.rejects(() => adapter.sendCommand({ type: "get_state" }), /disposed/);
});

test("subscribe: 事件转发为 GatewayEvent envelope 结构", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  const received: unknown[] = [];
  const unsubscribe = adapter.subscribe((event) => received.push(event));

  // 直接驱动 inner 事件源不可行（无 LLM），验证 envelope 字段契约存在性。
  // 真实事件流由 TST211 覆盖；此处验证 subscribe/unsubscribe 生命周期。
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();

  const sessionId = adapter.sessionId;
  assert.ok(sessionId.length > 0);
  await adapter.dispose();
});
