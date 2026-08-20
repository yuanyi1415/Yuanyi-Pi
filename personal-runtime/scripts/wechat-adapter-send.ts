/**
 * TST413：正式 WechatChannelAdapter 主动发送验证（不依赖入站消息）
 */
import { join } from "node:path";
import { MetadataStore } from "../src/metadata/store";
import { RuntimeManager } from "../src/runtime/manager";
import { SessionRouter } from "../src/session/router";
import { WechatChannelAdapter } from "../src/channel/wechat/index";

const target = process.argv[2] ?? "o9cq80wTHm9OC2BDCnZfDxslJfRQ@im.wechat";
const dataDir = process.env.YUANYI_PI_DATA_DIR ?? `${process.env.HOME}/.yuanyi-pi`;
const agentDir = process.env.YUANYI_PI_AGENT_DIR ?? `${process.env.HOME}/.pi-dev/agent`;

const metadata = new MetadataStore(join(dataDir, "metadata.json"));
metadata.load();
const runtimeManager = new RuntimeManager({ agentDir });
const router = new SessionRouter({ runtimeManager, metadata, neutralCwd: join(dataDir, "neutral") });
const adapter = new WechatChannelAdapter({
  transportConfig: { stateDir: join(dataDir, "wechat") },
  router, runtimeManager, metadata,
});

await adapter.start();
const before = metadata.getBinding("wechat", `wechat:${target}`);
await adapter.send(target, `主动发送测试-${new Date().toISOString()}`);
const after = metadata.getBinding("wechat", `wechat:${target}`);
console.log("✅ 主动发送完成");
console.log("binding 未改变:", before?.activeSessionId === after?.activeSessionId);
await adapter.stop();
process.exit(0);
