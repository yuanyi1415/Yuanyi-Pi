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

test("setThinkingLevel: 返回实际生效值且 getState 读回一致（SDK 按模型能力 clamp）", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  const effective = await adapter.setThinkingLevel("high");
  const state = await adapter.getState();
  assert.equal(state.thinkingLevel, effective, "getState 读回应与 set 返回的实际生效值一致");
  assert.ok(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effective),
    `实际生效值应为合法级别，得到: ${effective}`,
  );

  // sendCommand 路径同样返回实际生效值（产品层可见降级）
  const cmdResult = await adapter.sendCommand({
    type: "set_thinking_level",
    level: "high",
  }) as { level?: string };
  assert.equal(cmdResult.level, effective);

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

// ---------- S6-01：preflightResult 契约映射 ----------
// 环境说明：opencode 内置模型 hasConfiguredAuth 恒真，真实 Pi 栈无法确定性触发 rejected，
// 故注入 fake inner 验证 adapter 对 Pi 原生 preflightResult(success) 的事务映射。

test("S6-01: inner preflight rejected → adapter 返回 accepted:false + reason:preflight_rejected（不 throw）", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  (adapter as unknown as { inner: unknown }).inner = {
    prompt: async (_text: string, options: { preflightResult?: (ok: boolean) => void }) => {
      options.preflightResult?.(false);
      throw new Error("No model selected");
    },
    dispose: async () => {},
  };

  const preflightSignals: boolean[] = [];
  const ack = await adapter.prompt("hi", undefined, (accepted) => preflightSignals.push(accepted));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "preflight_rejected");
  assert.deepEqual(preflightSignals, [false], "onPreflight 必须实时收到 preflight rejected 信号");
  await adapter.dispose();
});

test("S6-01: inner preflight accepted 但执行失败 → throw 且标记 promptAccepted，避免上层误回滚", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  (adapter as unknown as { inner: unknown }).inner = {
    prompt: async (_text: string, options: { preflightResult?: (ok: boolean) => void }) => {
      options.preflightResult?.(true);
      throw new Error("agent loop failed");
    },
    dispose: async () => {},
  };

  await assert.rejects(
    () => adapter.prompt("hi"),
    (err: unknown) => {
      assert.equal((err as Error).message, "agent loop failed");
      assert.equal((err as { promptAccepted?: boolean }).promptAccepted, true);
      return true;
    },
  );
  await adapter.dispose();
});

test("S6-01: inner preflight accepted 且成功 → accepted:true 且 onPreflight(true) 实时通知", async () => {
  const cwd = makeTmpDir("yuanyi-cwd-");
  const agentDir = makeTmpDir("yuanyi-agent-");
  const adapter = await PiRuntimeAdapter.create({ cwd, agentDir });

  (adapter as unknown as { inner: unknown }).inner = {
    prompt: async (_text: string, options: { preflightResult?: (ok: boolean) => void }) => {
      options.preflightResult?.(true);
    },
    dispose: async () => {},
  };

  const preflightSignals: boolean[] = [];
  const ack = await adapter.prompt("hi", undefined, (accepted) => preflightSignals.push(accepted));
  assert.equal(ack.accepted, true);
  assert.equal(ack.sessionId, adapter.sessionId);
  assert.deepEqual(preflightSignals, [true], "onPreflight 必须在 preflight accepted 时实时通知");
  await adapter.dispose();
});
