/**
 * Personal Runtime 主入口：加载配置 / 对齐 SDK agentDir / 启动 Gateway HTTP+SSE
 * + 可选微信 Channel。
 *
 * 开发运行（隔离，永不误写生产）：
 *   YUANYI_PI_DATA_DIR=~/.pi-dev/.yuanyi-pi \
 *   YUANYI_PI_AGENT_DIR=~/.pi-dev/agent \
 *   YUANYI_PI_WECHAT_ENABLED=1 \
 *   npm start
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config/index";

const config = loadConfig();

// 在 SDK 调用前对齐 agentDir（getAgentDir/getSessionsDir/listAll 均读该变量）
process.env.PI_CODING_AGENT_DIR = config.agentDir;

import { MetadataStore } from "./metadata/store";
import { RuntimeManager } from "./runtime/manager";
import { SessionRouter } from "./session/router";
import { createGatewayServer } from "./server/gateway";
import { WechatChannelAdapter } from "./channel/wechat";
import { ChannelConfigStore } from "./channel/wechat/config";
import { WechatChannelController } from "./channel/wechat/controller";

async function main(): Promise<void> {
  console.log("[personal-runtime] config:", JSON.stringify(config));

  // neutralCwd 必须真实存在：无项目 Session 的 Agent 工具（bash/文件）需要有效工作目录
  mkdirSync(config.neutralCwd, { recursive: true });

  // 渠道配置存储：adapter 与 controller 必须共享同一实例（否则配置缓存不一致）
  const channelConfigStore = new ChannelConfigStore(config.dataDir);

  const metadata = new MetadataStore(join(config.dataDir, "metadata.json"));
  metadata.load();

  const runtimeManager = new RuntimeManager({ agentDir: config.agentDir });
  const router = new SessionRouter({
    runtimeManager,
    metadata,
    neutralCwd: config.neutralCwd,
  });

  // 微信 Channel（一期：私聊文本）
  let wechatAdapter: WechatChannelAdapter | null = null;
  if (config.wechat.enabled) {
    wechatAdapter = new WechatChannelAdapter({
      transportConfig: {
        stateDir: config.wechat.stateDir,
        pollTimeout: 35,
        qrLogin: {
          onQrCode: (url) => {
            // 一期：打印二维码 URL（接入 WebUI 时可替换为页面展示）
            console.log(`[wechat] 请扫码登录: ${url}`);
          },
        },
      },
      router,
      runtimeManager,
      metadata,
      configStore: channelConfigStore,
      onAuthExpired: () => {
        console.error("[wechat] token 失效，需重新扫码（运行 wechat:login 或重启）");
      },
    });
    console.log("[wechat] channel starting...");
    await wechatAdapter.start();
    console.log("[wechat] channel started（长轮询接收中）");
  }

  // 渠道管理（状态 + 扫码连接）
  let wechatController: WechatChannelController | null = null;
  if (config.wechat.enabled) {
    wechatController = new WechatChannelController({
      stateDir: config.wechat.stateDir,
      isRunning: () => wechatAdapter?.transport.isRunning?.() ?? false,
      isAuthExpired: () => wechatAdapter?.transport.isAuthExpired?.() ?? false,
      configStore: channelConfigStore,
      onDisconnect: async () => { await wechatAdapter?.stop(); },
      onConnect: async () => { await wechatAdapter?.start(); },
    });
  }

  const server = createGatewayServer(router, runtimeManager, wechatController ?? undefined);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[personal-runtime] gateway listening on http://127.0.0.1:${config.port}`);
  });

  const shutdown = async () => {
    console.log("[personal-runtime] shutting down...");
    server.close();
    await wechatAdapter?.stop();
    await runtimeManager.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
