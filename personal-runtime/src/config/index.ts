/**
 * Personal Runtime 配置（DEV211 开发配置）
 *
 * 数据目录隔离铁律：
 * - 生产默认 ~/.yuanyi-pi（独立于 ~/.pi/agent）
 * - 开发必须显式注入 YUANYI_PI_DATA_DIR=~/.pi-dev/.yuanyi-pi，永不误写生产数据
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
  /** Personal 数据目录（metadata.json / runtime / logs） */
  dataDir: string;
  /** Pi Agent 数据目录（auth/models/sessions）；通过 PI_CODING_AGENT_DIR 对齐 SDK */
  agentDir: string;
  /** Personal Gateway HTTP/SSE 监听端口（默认 8770，避开 pi-web 30141/30142） */
  port: number;
  /** 无项目 Session 的安全默认运行目录（不展示为项目，不使用用户 Home） */
  neutralCwd: string;
  /** 微信 Channel 配置（一期：私聊文本） */
  wechat: {
    enabled: boolean;
    stateDir: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = env.YUANYI_PI_DATA_DIR ?? join(homedir(), ".yuanyi-pi");
  const agentDir = env.YUANYI_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const port = Number(env.YUANYI_PI_PORT ?? 8770);
  return {
    dataDir,
    agentDir,
    port,
    neutralCwd: join(dataDir, "neutral"),
    wechat: {
      enabled: env.YUANYI_PI_WECHAT_ENABLED === "1",
      stateDir: env.YUANYI_PI_WECHAT_STATE_DIR ?? join(dataDir, "wechat"),
    },
  };
}
