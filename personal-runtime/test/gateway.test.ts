/**
 * Gateway HTTP API 单元测试（DEV222 / DEV223 / DEV224）
 *
 * 隔离：临时 sessionDir + 临时 metadata + 临时 cwd/agentDir，不依赖真实 LLM。
 * SSE 事件流依赖真实 Agent 事件（TST211 覆盖）；此处验证路由/状态码/负载结构。
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GatewayEvent } from "../src/contracts";
import { MetadataStore } from "../src/metadata/store";
import { RuntimeManager } from "../src/runtime/manager";
import { SessionRouter } from "../src/session/router";
import { Gateway, createGatewayServer } from "../src/server/gateway";

let server: Server;
let base: string;
let sessionDir: string;

function makeSessionFile(cwd: string, sessionDir: string): { sessionFile: string; sessionId: string } {
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] } as never);
  return { sessionFile: sm.getSessionFile()!, sessionId: sm.getSessionId() };
}

before(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gw-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "gw-agent-"));
  sessionDir = mkdtempSync(join(tmpdir(), "gw-sess-"));
  const metadataFile = join(mkdtempSync(join(tmpdir(), "gw-meta-")), "metadata.json");

  const metadata = new MetadataStore(metadataFile);
  metadata.load();
  const runtimeManager = new RuntimeManager({ agentDir });
  const router = new SessionRouter({ runtimeManager, metadata, neutralCwd: cwd, sessionDir });

  server = createGatewayServer(router, runtimeManager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function apiOn(target: string, method: string, path: string, body?: unknown) {
  const res = await fetch(target + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 3000);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedCount: number,
): Promise<GatewayEvent[]> {
  const decoder = new TextDecoder();
  const events: GatewayEvent[] = [];
  let buffer = "";
  while (events.length < expectedCount) {
    const { done, value } = await withTimeout(reader.read(), "SSE 事件超时");
    assert.equal(done, false, "SSE 不应在收到全部事件前关闭");
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)) as GatewayEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

test("POST /v1/sessions 创建无项目 Session → 201 + descriptor", async () => {
  const { status, json } = await api("POST", "/v1/sessions", { projectDirectory: null });
  assert.equal(status, 201);
  assert.ok(json.sessionId);
  assert.equal(json.projectDirectory, null);
  assert.equal(json.running, true);
});

test("新建但尚未落盘的 Session 仍可通过 Gateway 查询", async () => {
  const created = await api("POST", "/v1/sessions", { projectDirectory: null });
  const read = await api("GET", `/v1/sessions/${created.json.sessionId}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.sessionId, created.json.sessionId);
  assert.equal(read.json.running, true);
});

test("GET /v1/sessions 列表包含新建 Session", async () => {
  await api("POST", "/v1/sessions", { projectDirectory: null });
  const { status, json } = await api("GET", "/v1/sessions");
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.sessions));
  assert.ok(json.sessions.length >= 1);
});

test("POST commands get_state 返回 runtime 状态", async () => {
  const created = await api("POST", "/v1/sessions", { projectDirectory: null });
  const { status, json } = await api("POST", `/v1/sessions/${created.json.sessionId}/commands`, {
    type: "get_state",
  });
  assert.equal(status, 200);
  assert.equal(json.state, "ready");
});

test("GET /v1/sessions/{id}/events：不存在的 Session → 404", async () => {
  const { status, json } = await api("GET", "/v1/sessions/no-such-id/events");
  assert.equal(status, 404);
  assert.equal(json.error, "session_not_found");
});

test("SSE 先发快照，再按序补发 getState 期间事件", async () => {
  let resolveSnapshot!: (state: Record<string, unknown>) => void;
  const snapshot = new Promise<Record<string, unknown>>((resolve) => {
    resolveSnapshot = resolve;
  });
  let listener: ((event: GatewayEvent) => void) | undefined;
  const runtime = {
    getState: () => snapshot,
    subscribe: (callback: (event: GatewayEvent) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };
  const gateway = new Gateway({} as never, {
    get: (id: string) => (id === "race" ? runtime : undefined),
  } as never);
  const raceServer = createServer((req, res) => {
    void gateway.handler(req, res);
  });
  await new Promise<void>((resolve) => raceServer.listen(0, "127.0.0.1", resolve));
  const address = raceServer.address();
  const raceBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const controller = new AbortController();

  try {
    const response = await fetch(`${raceBase}/v1/sessions/race/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(listener, "getState 完成前必须已订阅事件");
    listener({ sessionId: "race", sequence: 1, type: "one", timestamp: 1, payload: { n: 1 } });
    listener({ sessionId: "race", sequence: 2, type: "two", timestamp: 2, payload: { n: 2 } });
    resolveSnapshot({ state: "ready" });

    const events = await readSseEvents(response.body!.getReader(), 3);
    assert.deepEqual(events.map((event) => [event.sequence, event.type]), [
      [0, "state"],
      [1, "one"],
      [2, "two"],
    ]);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => raceServer.close(() => resolve()));
  }
});

test("GET /v1/sessions/{id}/events：已落盘未激活 Session 懒恢复 → 200 + 初始快照", async () => {
  // 构造真实已落盘 Session（runtime 未激活），模拟 gateway 重启后前端先连事件流的场景
  const cwd = mkdtempSync(join(tmpdir(), "gw-evt-cwd-"));
  const { sessionId } = makeSessionFile(cwd, sessionDir);

  const controller = new AbortController();
  const res = await fetch(base + `/v1/sessions/${sessionId}/events`, {
    signal: controller.signal,
  });
  // SSE 长连接：headers 就绪即证明懒恢复成功（旧行为在此返回 409）
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  // 读第一块验证初始快照（state 事件）能到达
  const reader = res.body!.getReader();
  const first = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("SSE 初始快照超时")), 3000),
    ),
  ]);
  assert.ok(first.includes("data:"), `初始快照应含 data: 事件，实际: ${JSON.stringify(first)}`);
  controller.abort();
});

test("未知路由 404", async () => {
  const { status } = await api("GET", "/v1/nope");
  assert.equal(status, 404);
});

test("/health 返回 liveness", async () => {
  const { status, json } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, service: "personal-runtime" });
});

test("Session context / rename / delete 均经 Gateway", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gw-context-cwd-"));
  const { sessionId: id } = makeSessionFile(cwd, sessionDir);
  const context = await api("GET", `/v1/sessions/${id}/context`);
  assert.equal(context.status, 200);
  assert.ok(Array.isArray(context.json.context.messages));
  const document = await api("GET", `/v1/sessions/${id}/document`);
  assert.equal(document.status, 200);
  assert.equal(document.json.info.id, id);
  assert.equal(typeof document.json.totalActiveMs, "number");
  assert.equal("entries" in document.json, false);

  const renamed = await api("POST", `/v1/sessions/${id}/commands`, {
    type: "set_session_name",
    name: "gateway title",
  });
  assert.equal(renamed.status, 200);
  const deleted = await api("DELETE", `/v1/sessions/${id}`);
  assert.deepEqual(deleted, { status: 200, json: { ok: true } });
  const missing = await api("GET", `/v1/sessions/${id}`);
  assert.equal(missing.status, 404);
});

test("/context 与 /document 共享 deferThinking/deferMedia 投影", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gw-defer-cwd-"));
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] } as never);
  sm.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "answer" },
    ],
  } as never);
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    content: [
      { type: "text", text: "tool output" },
      { type: "image", data: "QUJDRA==", mimeType: "image/png" },
    ],
  } as never);
  const id = sm.getSessionId();

  const query = "?deferThinking=1&deferMedia=1";
  const context = await api("GET", `/v1/sessions/${id}/context${query}`);
  const document = await api("GET", `/v1/sessions/${id}/document${query}`);
  const full = await api("GET", `/v1/sessions/${id}/document`);
  assert.equal(context.status, 200);
  assert.equal(document.status, 200);
  assert.deepEqual(document.json.context.messages, context.json.context.messages);

  const assistant = context.json.context.messages.find((message: { role?: string }) => message.role === "assistant");
  assert.equal(assistant.content[0].thinking, "");
  assert.equal(assistant.content[0].deferred, true);
  const toolResult = context.json.context.messages.find((message: { role?: string }) => message.role === "toolResult");
  assert.ok(toolResult.content.every((block: unknown) => (
    typeof block !== "object" || block === null || (block as { type?: string }).type !== "image"
  )));
  assert.ok(full.json.context.messages.some((message: { role?: string; content?: unknown[] }) => (
    message.role === "toolResult" && message.content?.some((block: unknown) => (
      typeof block === "object" && block !== null && (block as { type?: string }).type === "image"
    ))
  )));
});

// ---------- S6-01：首次 Prompt preflight 事务边界 ----------

test("S6-01: prepare + 首次 prompt preflight rejected → Session 不正式化（无 metadata / 无 project / 不入列表）", async () => {
  // 环境说明：opencode 内置模型 hasConfiguredAuth 恒真，无法用真实 Pi 栈确定性触发 preflight rejected，
  // 故改为验证“preflight rejected 时 Gateway 仅回滚、不 commit/finalize”的事务边界（见下一测试）；
  // adapter 层 preflight 契约映射见 pi-adapter.test.ts。真实 LLM rejected 端到端验收归 S6-03。
  const calls: string[] = [];
  const fakeRouter = {
    commitPrepared: () => calls.push("commit"),
    finalizePrepared: () => calls.push("finalize"),
    rollbackPrepared: async () => calls.push("rollback"),
  };

  // rejected → 仅 rollback
  const rejectedGateway = new Gateway(fakeRouter as never, {
    get: () => ({}),
    sendCommand: async () => ({ accepted: false, reason: "preflight_rejected", sessionId: "prepared-1" }),
  } as never);
  const rejectedServer = createServer((req, res) => {
    void rejectedGateway.handler(req, res);
  });
  await new Promise<void>((resolve) => rejectedServer.listen(0, "127.0.0.1", resolve));
  const rejectedAddress = rejectedServer.address();
  const rejectedBase = `http://127.0.0.1:${typeof rejectedAddress === "object" && rejectedAddress ? rejectedAddress.port : 0}`;
  try {
    const no = await apiOn(rejectedBase, "POST", "/v1/sessions/prepared-1/commands", { type: "prompt", message: "hi" });
    assert.equal(no.status, 200);
    assert.equal(no.json.accepted, false);
    assert.deepEqual(calls, ["rollback"], "rejected → 仅 rollback，不 commit/finalize");
  } finally {
    await new Promise<void>((resolve) => rejectedServer.close(() => resolve()));
  }

  // accepted → commit + finalize，不 rollback
  calls.length = 0;
  const acceptedGateway = new Gateway(fakeRouter as never, {
    get: () => ({}),
    sendCommand: async () => ({ accepted: true, sessionId: "prepared-1" }),
  } as never);
  const acceptedServer = createServer((req, res) => {
    void acceptedGateway.handler(req, res);
  });
  await new Promise<void>((resolve) => acceptedServer.listen(0, "127.0.0.1", resolve));
  const acceptedAddress = acceptedServer.address();
  const acceptedBase = `http://127.0.0.1:${typeof acceptedAddress === "object" && acceptedAddress ? acceptedAddress.port : 0}`;
  try {
    const ok = await apiOn(acceptedBase, "POST", "/v1/sessions/prepared-1/commands", { type: "prompt", message: "hi" });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ["commit", "finalize"], "accepted → commit + finalize，不 rollback");
  } finally {
    await new Promise<void>((resolve) => acceptedServer.close(() => resolve()));
  }
});

test("S6-01 TEST-02: preflight accepted → 立即正式化（Agent 执行未结束时 Session 已 commit+finalize）", async () => {
  const calls: string[] = [];
  let releaseAgent!: () => void;
  const agentGate = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });

  const gateway = new Gateway({
    commitPrepared: () => calls.push("commit"),
    finalizePrepared: () => calls.push("finalize"),
    rollbackPrepared: async () => calls.push("rollback"),
  } as never, {
    get: () => ({}),
    sendCommand: async (
      _sessionId: string,
      command: { type: string },
      trace?: { onPromptPreflight?: (accepted: boolean) => void },
    ) => {
      if (command.type === "prompt") {
        trace?.onPromptPreflight?.(true);
        await agentGate; // Agent 仍在执行（长 Prompt / 异常前），Session 必须先成立
        return { accepted: true, sessionId: "prepared-1" };
      }
      return { state: "ready" };
    },
  } as never);
  const server = createServer((req, res) => {
    void gateway.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const pendingResponse = apiOn(base, "POST", "/v1/sessions/prepared-1/commands", { type: "prompt", message: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      calls,
      ["commit", "finalize"],
      "Agent 执行尚未结束时 Session 必须已 commit+finalize（Commit Point = preflight accepted）",
    );
    releaseAgent();
    const res = await pendingResponse;
    assert.equal(res.status, 200);
    assert.equal(res.json.accepted, true);
  } finally {
    releaseAgent();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("S6-01 TEST-03: preflight accepted + Agent 执行失败 → 不 rollback，Session 保持正式化", async () => {
  const calls: string[] = [];
  const gateway = new Gateway({
    commitPrepared: () => calls.push("commit"),
    finalizePrepared: () => calls.push("finalize"),
    rollbackPrepared: async () => calls.push("rollback"),
  } as never, {
    get: () => ({}),
    sendCommand: async (
      _sessionId: string,
      command: { type: string },
      trace?: { onPromptPreflight?: (accepted: boolean) => void },
    ) => {
      if (command.type === "prompt") {
        trace?.onPromptPreflight?.(true);
        const err = new Error("agent loop failed") as Error & { promptAccepted?: boolean };
        err.promptAccepted = true; // 模拟 adapter：preflight accepted 后执行期失败
        throw err;
      }
      return { state: "ready" };
    },
  } as never);
  const server = createServer((req, res) => {
    void gateway.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const res = await apiOn(base, "POST", "/v1/sessions/prepared-1/commands", { type: "prompt", message: "hi" });
    assert.equal(res.status, 500);
    assert.deepEqual(
      calls,
      ["commit", "finalize"],
      "preflight accepted 后执行失败不得 rollback 已成立的 Session",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------- S6-02：Project Remove 引用检查 ----------

test("S6-02: 有 Session 引用的 Project 删除 → 409 project_in_use，Registry 不变", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "s6-proj-cwd-"));
  const created = await api("POST", "/v1/sessions", { projectDirectory: cwd });
  assert.equal(created.status, 201);

  const removed = await api("DELETE", "/v1/projects", { projectDirectory: cwd });
  assert.equal(removed.status, 409);
  assert.equal(removed.json.error, "project_in_use");

  // Registry 不变：项目仍在列表中（路径以 canonical 形式存储）
  const canonical = realpathSync(cwd);
  const projects = await api("GET", "/v1/projects");
  assert.ok(projects.json.projects.some((project: { path: string }) => project.path === canonical));
  // 删除失败后 Session 引用保持（Session 仍可查询）
  const read = await api("GET", `/v1/sessions/${created.json.sessionId}`);
  assert.equal(read.status, 200);
  // “删除最后一个关联 Session 后可删项目”的完整链路由 session-router 测试覆盖（需已落盘 Session）
});

test("S6-02: 无 Session 引用的 Project 删除 → 200 且刷新不重新出现", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "s6-proj2-cwd-"));
  // 直接通过 metadata 注册一个无引用 Project（避免创建 Session）
  const metaFile = join(mkdtempSync(join(tmpdir(), "s6-proj2-meta-")), "metadata.json");
  const metadata = new MetadataStore(metaFile);
  metadata.load();
  metadata.upsertProject(cwd, "Lonely");

  const router = new SessionRouter({
    runtimeManager: new RuntimeManager({ agentDir: mkdtempSync(join(tmpdir(), "s6-proj2-agent-")) }),
    metadata,
    neutralCwd: mkdtempSync(join(tmpdir(), "s6-proj2-neutral-")),
    sessionDir: mkdtempSync(join(tmpdir(), "s6-proj2-sess-")),
  });
  const s6Gateway = new Gateway(router as never, {} as never);
  const s6Server = createServer((req, res) => {
    void s6Gateway.handler(req, res);
  });
  await new Promise<void>((resolve) => s6Server.listen(0, "127.0.0.1", resolve));
  const s6Address = s6Server.address();
  const s6Base = `http://127.0.0.1:${typeof s6Address === "object" && s6Address ? s6Address.port : 0}`;
  try {
    const removed = await apiOn(s6Base, "DELETE", "/v1/projects", { projectDirectory: cwd });
    assert.equal(removed.status, 200);
    const projects = await apiOn(s6Base, "GET", "/v1/projects");
    assert.equal(projects.json.projects.some((project: { path: string }) => project.path === cwd), false);
  } finally {
    await new Promise<void>((resolve) => s6Server.close(() => resolve()));
  }
});
