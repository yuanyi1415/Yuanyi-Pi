/**
 * 渠道配置持久化（FR-102 设置真实生效）
 *
 * 存于 dataDir/channels.json：
 * { wechat: { allowFrom, progressEnabled, toolHintsEnabled, replyProgressEnabled,
 *             replyProgressMax, blockStreaming, blockMinChars, blockMaxMessages } }
 * 原子写 + 运行时读取（transport/adapter 按需查询，改动即时生效）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WechatChannelConfig {
  allowFrom: string[];
  progressEnabled: boolean;
  toolHintsEnabled: boolean;
  replyProgressEnabled: boolean;
  replyProgressMax: number;
  blockStreaming: boolean;
  blockMinChars: number;
  blockMaxMessages: number;
}

/**
 * 默认值与 nanobot 一致：
 * - progressEnabled（处理中提示/typing）：nanobot 的 typing 总是开启，保留 true
 * - toolHintsEnabled（工具提示）：nanobot sendToolHints=false
 * - replyProgressEnabled（结构化进度）：nanobot replyProgressMessages=false
 * - blockStreaming（分块发送）：nanobot blockStreaming=false
 */
export const DEFAULT_WECHAT_CONFIG: WechatChannelConfig = {
  allowFrom: [],
  progressEnabled: true,
  toolHintsEnabled: false,
  replyProgressEnabled: false,
  replyProgressMax: 2,
  blockStreaming: false,
  blockMinChars: 1200,
  blockMaxMessages: 3,
};

export class ChannelConfigStore {
  private cached: WechatChannelConfig | null = null;

  constructor(private readonly dataDir: string) {}

  private file(): string {
    return join(this.dataDir, "channels.json");
  }

  get(): WechatChannelConfig {
    if (this.cached) return this.cached;
    const file = this.file();
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { wechat?: Partial<WechatChannelConfig> };
        this.cached = { ...DEFAULT_WECHAT_CONFIG, ...(raw.wechat ?? {}) };
        return this.cached;
      } catch {
        // 损坏则用默认
      }
    }
    this.cached = { ...DEFAULT_WECHAT_CONFIG };
    return this.cached;
  }

  set(partial: Partial<WechatChannelConfig>): WechatChannelConfig {
    const next = { ...this.get(), ...partial };
    this.cached = next;
    mkdirSync(this.dataDir, { recursive: true });
    const file = this.file();
    const tmp = join(this.dataDir, ".channels.json.tmp");
    writeFileSync(tmp, JSON.stringify({ wechat: next }, null, 2), "utf8");
    renameSync(tmp, file);
    return next;
  }
}
