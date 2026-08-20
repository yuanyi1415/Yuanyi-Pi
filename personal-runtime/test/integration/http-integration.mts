/**
 * TST211-214 集成验证：通过 Personal Gateway HTTP 完成真实 LLM 闭环。
 *
 * 覆盖：
 * - TST211 创建 Session → Prompt → Streaming
 * - TST212 Runtime dispose → 同 Session 恢复 → 继续 Prompt
 * - TST213 Session 级模型切换并恢复状态
 * - TST214 无项目 / 真实目录两种 Session 均正确运行
 *
 * 环境：agentDir=~/.pi-dev/agent（开发配置，隔离生产）；sessionDir/neutralCwd 为临时目录。
 * 运行：npx tsx test/integration/http-integration.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MetadataStore } from "../../src/metadata/store";
import { RuntimeManager } from "../../src/runtime/manager";
import { SessionRouter } from "../../src/session/router";
import { createGatewayServer } from "../../src/server/gateway";

const AGENT_DIR = join(homedir(), ".pi-dev", "agent");
// 对齐 SDK agentDir（getSessionsDir/listAll 无参时读该变量），使 session 落盘与扫描一致
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const ALT_MODEL = { provider: "opencode-go", modelId: "kimi-k2.6" };

async function main() {
  const tmp = mkdtempSync(join("/tmp", "tst-"));
  const metadata = new MetadataStore(join(tmp, "metadata.json"));
  metadata.load();
  const runtimeManager = new RuntimeManager({ agentDir: AGENT_DIR });
  const router = new SessionRouter({
    runtimeManager,
    metadata,
    neutralCwd: join(tmp, "neutral"),
  });
  const server = createGatewayServer(router, runtimeManager);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    console.log("\n===== TST211 创建 Session → Prompt → Streaming =====");
    const r211 = await tst211(base);
    console.log("✅ TST211 通过: sessionId=%s events=%d", r211.sessionId, r211.events.length);

    console.log("\n===== TST212 dispose → 恢复 → 继续 Prompt =====");
    await tst212(base, runtimeManager, r211.sessionId);
    console.log("✅ TST212 通过");

    console.log("\n===== TST213 Session 级模型切换并恢复 =====");
    await tst213(base, runtimeManager);
    console.log("✅ TST213 通过");

    console.log("\n===== TST214 无项目 / 真实目录 =====");
    await tst214(base, tmp);
    console.log("✅ TST214 通过");

    console.log("\n🎉 TST211-214 全部通过");
  } finally {
    await runtimeManager.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function api(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 打开 SSE 连接收集事件，返回 { events, close } */
async function openSSE(base: string, sessionId: string) {
  const events: Array<{ type: string; sequence: number; payload: { type?: string } }> = [];
  const res = await fetch(base + `/v1/sessions/${sessionId}/events`);
  if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let closed = false;
  const readLoop = (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              events.push(JSON.parse(dataLine.slice(6)));
            } catch {
              // 忽略非 JSON 行
            }
          }
        }
      }
    } catch {
      // reader.cancel() 中断读循环属正常关闭路径
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    events,
    close: async () => {
      closed = true;
      try {
        await reader.cancel();
      } catch {
        // 已关闭
      }
      await readLoop;
    },
  };
}

/** 发 prompt 并等待 agent_end 事件 */
async function promptAndWait(base: string, sessionId: string, message: string, timeoutMs = 180000) {
  const sse = await openSSE(base, sessionId);
  await new Promise((r) => setTimeout(r, 200)); // 等待 SSE 就绪
  const ack = await api(base, "POST", `/v1/sessions/${sessionId}/commands`, {
    type: "prompt",
    message,
  });
  assert.equal(ack.accepted, true, `prompt accepted: ${message}`);
  await waitFor(
    () => sse.events.some((e) => e.type === "agent_end"),
    timeoutMs,
    `agent_end for prompt: ${message}`,
  );
  sse.close();
  return sse.events;
}

// ---------- TST211 ----------
async function tst211(base: string) {
  const created = await api(base, "POST", "/v1/sessions", { projectDirectory: null });
  assert.ok(created.sessionId);
  assert.equal(created.running, true);
  assert.equal(created.projectDirectory, null);

  const events = await promptAndWait(base, created.sessionId, "只回复两个字：收到");
  const messageEvents = events.filter(
    (e) => e.type === "message" || (e.payload?.type ?? e.type) === "message",
  );
  // 至少收到 streaming 事件（message_start / text 等）
  assert.ok(events.length >= 2, `收到事件数=${events.length}`);

  const state = await api(base, "GET", `/v1/sessions/${created.sessionId}`);
  assert.equal(state.sessionId, created.sessionId);
  return { sessionId: created.sessionId, events };
}

// ---------- TST212 ----------
async function tst212(base: string, mgr: RuntimeManager, sessionId: string) {
  // dispose 释放 Runtime（持久 Session 保留）
  await mgr.dispose(sessionId);

  // 恢复：GET session 触发 resume
  const resumed = await api(base, "GET", `/v1/sessions/${sessionId}`);
  assert.equal(resumed.sessionId, sessionId, "恢复后 sessionId 不变");
  assert.equal(resumed.running, true);

  // 继续 prompt：上下文应保持（问“刚才我让你回复什么”）
  const events = await promptAndWait(
    base,
    sessionId,
    "用一句话回答：你回复上一条用户消息时说了哪两个字？",
  );
  assert.ok(events.length >= 1);
}

// ---------- TST213 ----------
async function tst213(base: string, mgr: RuntimeManager) {
  const created = await api(base, "POST", "/v1/sessions", { projectDirectory: null });
  const sessionId = created.sessionId;

  // 切换模型
  const setRes = await api(base, "POST", `/v1/sessions/${sessionId}/commands`, {
    type: "set_model",
    model: ALT_MODEL,
  });
  assert.equal(setRes.ok, true);

  // 发一条消息：既验证模型生效，也让 session 落盘（Pi 仅在有消息时写盘）
  await promptAndWait(base, sessionId, "回复：模型切换OK");

  let state = await api(base, "GET", `/v1/sessions/${sessionId}`);
  assert.equal(state.model?.modelId, ALT_MODEL.modelId, `set_model 生效: ${state.model?.modelId}`);

  // dispose 后恢复，模型状态应保持
  await mgr.dispose(sessionId);
  state = await api(base, "GET", `/v1/sessions/${sessionId}`);
  assert.equal(state.running, true);
  assert.equal(
    state.model?.modelId,
    ALT_MODEL.modelId,
    `恢复后模型保持: ${state.model?.modelId}`,
  );
}

// ---------- TST214 ----------
async function tst214(base: string, tmp: string) {
  // 无项目
  const noProject = await api(base, "POST", "/v1/sessions", { projectDirectory: null });
  assert.equal(noProject.projectDirectory, null);
  assert.ok(noProject.runtimeCwd.endsWith("neutral"), `neutralCwd: ${noProject.runtimeCwd}`);

  // 有项目（真实本地目录）
  const projectDir = mkdtempSync(join(tmp, "proj-"));
  const withProject = await api(base, "POST", "/v1/sessions", { projectDirectory: projectDir });
  assert.equal(withProject.projectDirectory, projectDir);
  assert.equal(withProject.runtimeCwd, projectDir);

  // 两种 Session 均能正常 prompt
  await promptAndWait(base, noProject.sessionId, "回复：无项目会话OK");
  await promptAndWait(base, withProject.sessionId, "回复：项目会话OK");
}

await main();
