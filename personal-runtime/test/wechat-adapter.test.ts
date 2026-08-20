/**
 * WechatChannelAdapter 单元测试（DEV412 / DEV413）
 *
 * 隔离：fake transport（只记录 send）+ 临时 metadata/sessionDir/cwd。
 * 验证：首次消息自动创建 Session 并绑定、继续同一 Session、/新会话、/列表、/继续、
 * 主动 send 不改变 binding。
 * （prompt→回复 收集依赖真实 LLM，由 TST411-413 覆盖）
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MetadataStore, channelKey } from "../src/metadata/store";
import { RuntimeManager } from "../src/runtime/manager";
import { SessionRouter } from "../src/session/router";
import { WechatChannelAdapter, type WechatTransportLike } from "../src/channel/wechat/adapter";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "wx-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "wx-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "wx-sess-"));
  const metadataFile = join(mkdtempSync(join(tmpdir(), "wx-meta-")), "metadata.json");

  const sent: Array<{ to: string; text: string }> = [];
  const fakeTransport: WechatTransportLike = {
    send: async (to, text) => {
      sent.push({ to, text });
    },
  };

  const metadata = new MetadataStore(metadataFile);
  metadata.load();
  const runtimeManager = new RuntimeManager({ agentDir });
  const router = new SessionRouter({
    runtimeManager,
    metadata,
    neutralCwd: join(cwd, "neutral"),
    sessionDir,
  });
  const adapter = new WechatChannelAdapter({
    transportConfig: { stateDir: join(cwd, "wx-state") },
    transport: fakeTransport,
    router,
    runtimeManager,
    metadata,
  });
  return { sent, metadata, runtimeManager, router, adapter, cwd };
}

const CONTACT = "wx-contact-001";

test("首次消息：自动创建无项目 Session 并写入 binding", async () => {
  const { metadata, adapter } = setup();
  await adapter.handleInbound({
    channelType: "wechat",
    contactId: CONTACT,
    messageId: "m1",
    text: "你好",
    receivedAt: Date.now(),
  });
  const binding = metadata.getBinding("wechat", channelKey("wechat", CONTACT));
  assert.ok(binding, "binding 已写入");
  assert.ok(binding.activeSessionId);
  const meta = metadata.getSessionMeta(binding.activeSessionId);
  assert.equal(meta?.projectDirectory, null, "无项目 Session");
  assert.equal(meta?.originChannel, "wechat");
});

test("已绑定消息：继续同一 Session（不新建）", async () => {
  const { metadata, adapter } = setup();
  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m1", text: "第一条", receivedAt: Date.now() });
  const binding1 = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;

  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m2", text: "第二条", receivedAt: Date.now() });
  const binding2 = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;
  assert.equal(binding2.activeSessionId, binding1.activeSessionId, "继续同一 Session");
  const sessions = Object.keys(metadata.getSessionMetaAll());
  assert.equal(sessions.length, 1, "只创建了一个 Session");
});

test("/新会话：创建新 Session 并切换 binding", async () => {
  const { metadata, adapter } = setup();
  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m1", text: "第一条", receivedAt: Date.now() });
  const before = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;

  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m2", text: "/新会话", receivedAt: Date.now() });
  const after = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;
  assert.notEqual(after.activeSessionId, before.activeSessionId, "切换到了新 Session");
  assert.equal(Object.keys(metadata.getSessionMetaAll()).length, 2);
});

test("/列表 + /继续 n：切换绑定到指定会话", async () => {
  const { metadata, adapter, sent } = setup();
  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m1", text: "会话A", receivedAt: Date.now() });
  const sessionA = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!.activeSessionId;

  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m2", text: "/新会话", receivedAt: Date.now() });
  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m3", text: "/列表", receivedAt: Date.now() });
  const listMsg = sent.find((s) => s.text.includes("最近会话"));
  assert.ok(listMsg, "列表消息已发送");

  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m4", text: "/继续 1", receivedAt: Date.now() });
  const switched = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;
  assert.equal(switched.activeSessionId, sessionA, "切换到会话A");
});

test("主动 send 不改变 binding", async () => {
  const { metadata, adapter, sent } = setup();
  await adapter.handleInbound({ channelType: "wechat", contactId: CONTACT, messageId: "m1", text: "你好", receivedAt: Date.now() });
  const before = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;

  await adapter.send(CONTACT, "主动消息测试");
  const after = metadata.getBinding("wechat", channelKey("wechat", CONTACT))!;
  assert.equal(after.activeSessionId, before.activeSessionId, "主动发送不改变绑定");
  assert.equal(sent.at(-1)?.text, "主动消息测试");
});
