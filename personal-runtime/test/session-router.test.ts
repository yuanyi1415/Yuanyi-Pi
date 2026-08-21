/**
 * MetadataStore + SessionRouter 单元测试（DEV214）
 *
 * 隔离：临时 sessionDir（扁平 .jsonl）+ 临时 metadata 文件 + 临时 cwd/agentDir。
 * 验证：MetadataStore 原子写入/binding/损坏容错；Router 新建（无项目/有项目）、
 * 已有 Session 恢复、list 合并与 orphan 标记。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MetadataStore, channelKey } from "../src/metadata/store";
import { RuntimeManager } from "../src/runtime/manager";
import { SessionRouter } from "../src/session/router";

function tmp() {
  return {
    cwd: mkdtempSync(join(tmpdir(), "sr-cwd-")),
    agentDir: mkdtempSync(join(tmpdir(), "sr-agent-")),
    sessionDir: mkdtempSync(join(tmpdir(), "sr-sess-")),
    neutralCwd: mkdtempSync(join(tmpdir(), "sr-neutral-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "sr-workspaces-")),
    metadataFile: join(mkdtempSync(join(tmpdir(), "sr-meta-")), "metadata.json"),
  };
}

function makeSessionFile(cwd: string, sessionDir: string): { sessionFile: string; sessionId: string } {
  const sm = SessionManager.create(cwd, sessionDir);
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] } as never);
  return { sessionFile: sm.getSessionFile()!, sessionId: sm.getSessionId() };
}

function makeRouter(t: ReturnType<typeof tmp>) {
  const metadata = new MetadataStore(t.metadataFile);
  metadata.load();
  const runtimeManager = new RuntimeManager({ agentDir: t.agentDir });
  const router = new SessionRouter({
    runtimeManager,
    metadata,
    neutralCwd: t.neutralCwd,
    workspaceRoot: t.workspaceRoot,
    sessionDir: t.sessionDir,
  });
  return { metadata, runtimeManager, router };
}

// ---------- MetadataStore ----------

test("MetadataStore: setSessionMeta 原子落盘并可读回", () => {
  const t = tmp();
  const metadata = new MetadataStore(t.metadataFile);
  metadata.load();
  metadata.setSessionMeta("sess-1", { projectDirectory: null, originChannel: "web" });
  metadata.setSessionMeta("sess-2", { projectDirectory: "/tmp/proj", originChannel: "wechat" });

  const reloaded = new MetadataStore(t.metadataFile);
  reloaded.load();
  assert.deepEqual(reloaded.getSessionMeta("sess-1"), { projectDirectory: null, originChannel: "web" });
  assert.equal(reloaded.getSessionMeta("sess-2")?.projectDirectory, "/tmp/proj");
  // 无临时文件残留
  assert.equal(existsSync(join(join(t.metadataFile, ".."), ".metadata.json.tmp")), false);
});

test("MetadataStore: channel binding set/get/remove", () => {
  const t = tmp();
  const metadata = new MetadataStore(t.metadataFile);
  metadata.load();
  const key = channelKey("acc-1", "contact-1");
  metadata.setBinding("wechat", key, { activeSessionId: "sess-9" });
  assert.equal(metadata.getBinding("wechat", key)?.activeSessionId, "sess-9");
  metadata.removeBinding("wechat", key);
  assert.equal(metadata.getBinding("wechat", key), undefined);
});

test("MetadataStore: 损坏文件容错（不抛错，保持空结构）", () => {
  const t = tmp();
  writeFileSync(t.metadataFile, "{invalid json");
  const metadata = new MetadataStore(t.metadataFile);
  metadata.load(); // 不应抛错
  assert.equal(metadata.getSessionMeta("x"), undefined);
});

// ---------- SessionRouter ----------

test("SessionRouter: resolveNew 无项目 → 每个 Session 使用独立 workspace，metadata 落盘", async () => {
  const t = tmp();
  const { router } = makeRouter(t);
  const desc = await router.resolve({ type: "new", input: { projectDirectory: null } });
  assert.equal(desc.projectDirectory, null);
  assert.notEqual(desc.runtimeCwd, t.neutralCwd);
  assert.match(desc.runtimeCwd, new RegExp(`${t.workspaceRoot}/[^/]+$`));
  assert.equal(desc.originChannel, "web");
  assert.equal(desc.running, true);
});

test("SessionRouter: resolveNew 有项目 → runtimeCwd=projectDirectory", async () => {
  const t = tmp();
  const { router } = makeRouter(t);
  const desc = await router.resolve({
    type: "new",
    input: { projectDirectory: t.cwd, originChannel: "wechat" },
  });
  assert.equal(desc.projectDirectory, realpathSync(t.cwd));
  assert.equal(desc.runtimeCwd, realpathSync(t.cwd));
  assert.equal(desc.originChannel, "wechat");
});

test("SessionRouter: prepareNew 不落盘可见 Session，commit 后才进入列表", async () => {
  const t = tmp();
  const { metadata, router, runtimeManager } = makeRouter(t);
  const desc = await router.prepareNew({ projectDirectory: t.cwd, projectDisplayName: "Demo" });
  const canonical = realpathSync(t.cwd);

  assert.equal(metadata.getSessionMeta(desc.sessionId), undefined);
  assert.equal(metadata.getProject(canonical), undefined);
  assert.equal((await router.list()).some((session) => session.sessionId === desc.sessionId), false);

  router.commitPrepared(desc.sessionId);
  assert.equal(metadata.getSessionMeta(desc.sessionId)?.projectDirectory, canonical);
  assert.equal(metadata.getProject(canonical)?.displayName, "Demo");
  router.finalizePrepared(desc.sessionId);
  assert.equal((await router.list()).some((session) => session.sessionId === desc.sessionId), true);
  await runtimeManager.shutdown();
});

test("SessionRouter: resolveExisting 恢复已持久化 Session，sessionId 不变", async () => {
  const t = tmp();
  const { sessionFile, sessionId } = makeSessionFile(t.cwd, t.sessionDir);
  const { router } = makeRouter(t);

  const desc = await router.resolve({ type: "existing", sessionId });
  assert.equal(desc.sessionId, sessionId);
  assert.equal(desc.runtimeCwd, t.cwd);
  assert.equal(desc.running, true);
  assert.ok(existsSync(sessionFile));
});

test("SessionRouter: 删除会话清理所有指向它的微信 binding", async () => {
  const t = tmp();
  const { sessionFile, sessionId } = makeSessionFile(t.cwd, t.sessionDir);
  const { metadata, router } = makeRouter(t);
  const firstKey = channelKey("wechat", "contact-1");
  const secondKey = channelKey("wechat", "contact-2");
  const otherKey = channelKey("wechat", "contact-3");
  metadata.setBinding("wechat", firstKey, { activeSessionId: sessionId });
  metadata.setBinding("wechat", secondKey, { activeSessionId: sessionId });
  metadata.setBinding("wechat", otherKey, { activeSessionId: "other-session" });

  await router.deleteSession(sessionId);

  assert.equal(existsSync(sessionFile), false);
  assert.equal(metadata.getBinding("wechat", firstKey), undefined);
  assert.equal(metadata.getBinding("wechat", secondKey), undefined);
  assert.equal(metadata.getBinding("wechat", otherKey)?.activeSessionId, "other-session");
});

test("SessionRouter: removeProject 有 Session 引用 → 拒绝；无引用 → 删除且不被自动发现复活", async () => {
  const t = tmp();
  const { metadata, router } = makeRouter(t);
  const canonical = realpathSync(t.cwd);

  // 落盘 Session + metadata 项目引用（等价于已正式化的项目 Session）
  const { sessionId } = makeSessionFile(t.cwd, t.sessionDir);
  metadata.setSessionMeta(sessionId, { projectDirectory: canonical, originChannel: "web" });
  metadata.upsertProject(canonical, "Demo");
  assert.ok(metadata.getProject(canonical), "项目已注册");

  // 有引用 → 拒绝删除（含 raw 路径调用也应命中 canonical 存储）
  assert.throws(() => router.removeProject(t.cwd), /project in use/);
  assert.throws(() => router.removeProject(canonical), /project in use/);
  assert.ok(metadata.getProject(canonical), "Registry 保持不变");

  // 删除最后一个关联 Session 后 → 可删除，且 listProjects 不复活
  await router.deleteSession(sessionId);
  router.removeProject(t.cwd);
  assert.equal(metadata.getProject(canonical), undefined, "项目已删除");
  assert.equal(
    (await router.listProjects()).some((p) => p.path === canonical),
    false,
    "刷新后项目不重新出现",
  );

  // 不存在的项目 → project not found
  assert.throws(() => router.removeProject("/no/such/project"), /project not found/);
});

test("SessionRouter: removeProject 无引用项目（raw 路径注册）→ 删除成功", async () => {
  const t = tmp();
  const { metadata, router } = makeRouter(t);
  metadata.upsertProject(t.cwd, "Lonely");

  router.removeProject(t.cwd);
  assert.equal(metadata.getProject(t.cwd), undefined);
  assert.equal(
    (await router.listProjects()).some((p) => p.path === t.cwd),
    false,
    "刷新后项目不重新出现",
  );
});

test("SessionRouter: list 合并 Pi Session + metadata + running；orphan 标记", async () => {
  const t = tmp();
  const { metadata, router } = makeRouter(t);

  // 一个真实 session + metadata
  const { sessionId } = makeSessionFile(t.cwd, t.sessionDir);
  metadata.setSessionMeta(sessionId, { projectDirectory: null, originChannel: "web" });

  // 一个只有 metadata、无 Pi session 的 orphan
  metadata.setSessionMeta("ghost-session", { projectDirectory: null, originChannel: "wechat" });

  const list = await router.list();
  const real = list.find((s) => s.sessionId === sessionId);
  assert.ok(real, "真实 session 在列表中");
  assert.equal(real.projectDirectory, null);
  assert.equal(real.running, false);

  const ghost = list.find((s) => s.sessionId === "ghost-session");
  assert.ok(ghost, "orphan 标记存在");
  assert.equal(ghost.running, false);
});
