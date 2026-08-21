/**
 * RuntimeManager 单元测试（DEV213）
 *
 * 隔离策略同 DEV212：临时 cwd + 临时 agentDir；不依赖真实 LLM。
 * sessionId 以 Pi 生成为准（AD-003），resume 一律基于真实落盘 session 文件。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeManager } from "../src/runtime/manager";

function tmp() {
  return {
    cwd: mkdtempSync(join(tmpdir(), "rm-cwd-")),
    agentDir: mkdtempSync(join(tmpdir(), "rm-agent-")),
  };
}

/** 构造真实已落盘 Session 文件（user + assistant 消息才会写盘） */
function makeSessionFile(cwd: string, agentDir: string): { sessionFile: string; sessionId: string } {
  const sessionDir = join(agentDir, "sessions");
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] } as never);
  const sessionFile = sm.getSessionFile()!;
  assert.ok(existsSync(sessionFile));
  return { sessionFile, sessionId: sm.getSessionId() };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("启动锁：同一 sessionFile 并发 resume 只创建一个 Runtime", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });

  const [a, b] = await Promise.all([
    mgr.getOrCreate({ sessionFile, cwd }),
    mgr.getOrCreate({ sessionFile, cwd }),
  ]);
  assert.equal(a, b, "并发 resume 返回同一实例");
  assert.equal(mgr.getActiveSessionIds().length, 1);
  assert.ok(mgr.isRunning(a.sessionId));
  await mgr.shutdown();
});

test("不同 session 文件各自独立 Runtime", async () => {
  const { cwd, agentDir } = tmp();
  const f1 = makeSessionFile(cwd, agentDir);
  const f2 = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });

  const a = await mgr.getOrCreate({ sessionFile: f1.sessionFile, cwd });
  const b = await mgr.getOrCreate({ sessionFile: f2.sessionFile, cwd });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(mgr.getActiveSessionIds().length, 2);
  await mgr.shutdown();
});

test("dispose 后 getOrCreate 重建，sessionId 不变", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile, sessionId } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });

  const a = await mgr.getOrCreate({ sessionFile, cwd });
  assert.equal(a.sessionId, sessionId);
  await mgr.dispose(a.sessionId);
  assert.equal(mgr.isRunning(sessionId), false);

  const b = await mgr.getOrCreate({ sessionFile, cwd });
  assert.equal(b.sessionId, sessionId, "重建后 sessionId 不变");
  await mgr.shutdown();
});

test("普通 prompt 串行，失败后继续执行且清理队列尾链", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });
  const runtime = await mgr.getOrCreate({ sessionFile, cwd });
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  runtime.prompt = async (message) => {
    calls.push(message);
    if (message === "first") {
      await firstDone;
      throw new Error("prompt failed");
    }
    return { accepted: true, sessionId: runtime.sessionId };
  };
  runtime.sendCommand = async () => {
    throw new Error("普通 prompt 不应走 Pi sendCommand");
  };

  const first = mgr.sendCommand(runtime.sessionId, { type: "prompt", message: "first" });
  const second = mgr.sendCommand(runtime.sessionId, { type: "prompt", message: "second" });
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ["first"]);
  releaseFirst();
  await assert.rejects(first, /prompt failed/);
  assert.deepEqual(await second, { accepted: true, sessionId: runtime.sessionId });
  await waitFor(
    () =>
      (mgr as unknown as { operationTails: Map<string, Promise<unknown>> }).operationTails.size === 0,
  );
  await mgr.shutdown();
});

test("dispose 与已受理的 prompt 串行，dispose 不会中断运行中的 prompt", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });
  const runtime = await mgr.getOrCreate({ sessionFile, cwd });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let disposed = false;
  runtime.prompt = async () => {
    await gate;
    return { accepted: true, sessionId: runtime.sessionId };
  };
  runtime.dispose = async () => { disposed = true; };

  const prompt = mgr.prompt(runtime.sessionId, "long");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const dispose = mgr.dispose(runtime.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disposed, false);
  let resumed = false;
  const resume = mgr.getOrCreate({ sessionFile, cwd }).then(() => { resumed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resumed, false);
  release();
  await prompt;
  await dispose;
  await resume;
  assert.equal(resumed, true);
  assert.equal(disposed, true);
  await mgr.shutdown();
});

test("空闲回收：超时未活动被回收；touch 可防回收", async () => {
  const { cwd, agentDir } = tmp();
  const f1 = makeSessionFile(cwd, agentDir);
  const f2 = makeSessionFile(cwd, agentDir);
  // 短阈值：idle 100ms，扫描 20ms
  const mgr = new RuntimeManager({ agentDir, idleTimeoutMs: 100, scanIntervalMs: 20 });

  const kept = await mgr.getOrCreate({ sessionFile: f1.sessionFile, cwd });
  const reaped = await mgr.getOrCreate({ sessionFile: f2.sessionFile, cwd });

  // kept 持续 touch，reap 不 touch
  const touchTimer = setInterval(() => mgr.touch(kept.sessionId), 30);
  await waitFor(() => !mgr.isRunning(reaped.sessionId), 3000);
  clearInterval(touchTimer);

  assert.equal(mgr.isRunning(reaped.sessionId), false, "空闲 Runtime 已回收");
  assert.equal(mgr.isRunning(kept.sessionId), true, "持续活动的 Runtime 保留");
  await mgr.shutdown();
});

test("空闲扫描保护 streaming Runtime，仅真正 idle 后回收", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir, idleTimeoutMs: 100, scanIntervalMs: 20 });
  const runtime = await mgr.getOrCreate({ sessionFile, cwd });
  const ready = await runtime.getState();
  let state: typeof ready = { ...ready, state: "busy", isStreaming: true, isIdle: false };
  runtime.getState = async () => state;

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(mgr.isRunning(runtime.sessionId), true, "streaming Runtime 不应被回收");

  state = { ...ready, state: "ready", isStreaming: false, isIdle: true };
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(mgr.isRunning(runtime.sessionId), true, "刚进入 idle 时应重新计时");
  await waitFor(() => !mgr.isRunning(runtime.sessionId));
  await mgr.shutdown();
});

test("sendCommand get_state / getState 正常", async () => {
  const { cwd, agentDir } = tmp();
  const { sessionFile } = makeSessionFile(cwd, agentDir);
  const mgr = new RuntimeManager({ agentDir });

  const runtime = await mgr.getOrCreate({ sessionFile, cwd });
  const state = await mgr.getState(runtime.sessionId);
  assert.equal(state.state, "ready");
  const viaCmd = await mgr.sendCommand(runtime.sessionId, { type: "get_state" });
  assert.equal((viaCmd as { state: string }).state, "ready");
  await mgr.shutdown();
});
