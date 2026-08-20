/**
 * Gateway HTTP API 单元测试（DEV222 / DEV223 / DEV224）
 *
 * 隔离：临时 sessionDir + 临时 metadata + 临时 cwd/agentDir，不依赖真实 LLM。
 * SSE 事件流依赖真实 Agent 事件（TST211 覆盖）；此处验证路由/状态码/负载结构。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MetadataStore } from "../src/metadata/store";
import { RuntimeManager } from "../src/runtime/manager";
import { SessionRouter } from "../src/session/router";
import { createGatewayServer } from "../src/server/gateway";

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

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("POST /v1/sessions 创建无项目 Session → 201 + descriptor", async () => {
  const { status, json } = await api("POST", "/v1/sessions", { projectDirectory: null });
  assert.equal(status, 201);
  assert.ok(json.sessionId);
  assert.equal(json.projectDirectory, null);
  assert.equal(json.running, true);
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
