/**
 * WechatChannelAdapter（DEV412 / DEV413）
 *
 * 对接 Channel Contract（Stage-001 附录 C-4）：
 * - 把 WeChatTransport 入站消息映射为统一入站消息
 * - 微信联系人 Session Binding（MetadataStore.channelBindings.wechat）
 * - 无绑定 + 普通消息 → 自动创建无项目 Session 并绑定
 * - 已绑定 + 普通消息 → 继续当前 Session（上下文保持）
 * - 文本命令：/新会话（创建并切换）/ 列表（列出最近会话）/ 继续 <n>（切换）
 * - 主动发送默认不改变 activeSessionId
 * - 不直接 import Pi SDK（通过 SessionRouter / RuntimeManager 访问）
 */
import { channelKey, type MetadataStore } from "../../metadata/store";
import type { SessionRouter } from "../../session/router";
import type { RuntimeManager } from "../../runtime/manager";
import { WeChatTransport, splitWeixinMessage } from "./index";
import { DEFAULT_WECHAT_CONFIG, type ChannelConfigStore } from "./config";
import type { WechatInboundMessage, WechatTransportConfig } from "./index";

export interface WechatTransportLike {
  send(toUserId: string, text: string): Promise<unknown>;
  startTyping?(contactId: string): Promise<void>;
  stopTyping?(contactId: string, clearRemote?: boolean): Promise<void>;
  isRunning?(): boolean;
  isAuthExpired?(): boolean;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface WechatAdapterOptions {
  transportConfig: WechatTransportConfig;
  /** 测试注入用（可选，默认按 transportConfig 创建真实 transport） */
  transport?: WechatTransportLike;
  router: SessionRouter;
  runtimeManager: RuntimeManager;
  metadata: MetadataStore;
  /** 渠道配置存储（allowFrom / 工具提示 / 分块等设置即时生效） */
  configStore?: ChannelConfigStore;
  /** 最近会话列表条数（/列表） */
  recentListCount?: number;
  /** token 失效回调（重新扫码） */
  onAuthExpired?: () => void;
}

/** AgentMessage 提取文本（message_end 的 message） */
function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

export class WechatChannelAdapter {
  private readonly recentCount: number;
  readonly transport: WechatTransportLike;

  constructor(private readonly opts: WechatAdapterOptions) {
    this.recentCount = opts.recentListCount ?? 5;
    this.transport =
      opts.transport ??
      new WeChatTransport(
        opts.transportConfig,
        {
          onMessage: (msg) => this.handleInbound(msg),
          onAuthExpired: opts.onAuthExpired,
        },
        opts.configStore,
      );
  }

  /** 启动 Transport 并开始轮询接收 */
  async start(): Promise<void> {
    await this.transport.start?.();
  }

  async stop(): Promise<void> {
    await this.transport.stop?.();
  }

  /** 主动发送（默认不改变 activeSessionId） */
  async send(contactId: string, text: string): Promise<void> {
    await this.transport.send(contactId, text);
  }

  /**
   * 入站消息处理（DEV413 Binding 规则）
   */
  async handleInbound(msg: WechatInboundMessage): Promise<void> {
    const { router, metadata, runtimeManager } = this.opts;
    const transport = this.transport;
    const key = channelKey("wechat", msg.contactId);

    // ---- 文本命令（最小确定性交互，技术设计 3.6） ----
    const trimmed = msg.text.trim();
    if (trimmed === "/新会话" || trimmed === "/new") {
      const desc = await router.resolve({
        type: "new",
        input: { projectDirectory: null, originChannel: "wechat" },
      });
      metadata.setBinding("wechat", key, { activeSessionId: desc.sessionId });
      await transport.send(msg.contactId, `已创建新会话 ${desc.sessionId.slice(0, 8)}…`);
      return;
    }
    if (trimmed === "/列表" || trimmed === "/list" || trimmed === "/sessions") {
      await this.listSessions(msg.contactId);
      return;
    }
    const continueMatch = trimmed.match(/^\/继续\s+(\d+)$/) ?? trimmed.match(/^\/continue\s+(\d+)$/);
    if (continueMatch) {
      await this.switchSession(msg.contactId, Number(continueMatch[1]));
      return;
    }

    // ---- 普通消息：binding 查找 / 自动创建 ----
    let binding = metadata.getBinding("wechat", key);
    if (!binding) {
      const desc = await router.resolve({
        type: "new",
        input: { projectDirectory: null, originChannel: "wechat" },
      });
      metadata.setBinding("wechat", key, { activeSessionId: desc.sessionId });
      binding = { activeSessionId: desc.sessionId };
    }

    // ---- prompt 并收集回复（期间显示"正在输入"+工具提示/进度/分块）----
    await transport.startTyping?.(msg.contactId);
    try {
      const reply = await this.promptAndCollect(binding.activeSessionId, msg.contactId, msg.text);
      if (reply) {
        for (const chunk of splitWeixinMessage(reply)) {
          await transport.send(msg.contactId, chunk);
        }
      }
    } finally {
      await transport.stopTyping?.(msg.contactId);
    }
  }

  /** 发送到 Session 并收集回复；期间按配置发送工具提示/结构化进度/分块流式 */
  private async promptAndCollect(sessionId: string, contactId: string, text: string): Promise<string> {
    const { runtimeManager, router } = this.opts;
    const config = this.opts.configStore?.get() ?? DEFAULT_WECHAT_CONFIG;
    const transport = this.transport;
    if (!runtimeManager.get(sessionId)) {
      // Session 未激活 → 恢复
      await router.resolve({ type: "existing", sessionId });
    }
    const runtime = runtimeManager.get(sessionId);
    if (!runtime) throw new Error(`runtime not active: ${sessionId}`);

    const collected: string[] = [];
    const toolMessages: string[] = [];
    let streamBuffer = "";
    let blockSent = 0;
    let lastToolHintAt = 0;
    let lastTextLen = 0;
    const replySent = new Set<string>();

    const unsubscribe = runtime.subscribe((event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") return;
      const type = String(payload.type ?? "");

      // 工具提示 / 结构化进度（照抄 nanobot：合并缓冲，避免刷屏与配额）
      if (
        (type === "tool_execution_start" && config.toolHintsEnabled) ||
        (type === "tool_execution_end" && config.replyProgressEnabled)
      ) {
        const toolName = String(payload.toolName ?? "tool");
        const now = Date.now();
        if (type === "tool_execution_start") {
          if (now - lastToolHintAt > 2000) {
            toolMessages.push(`正在使用工具 [${toolName}]…`);
            lastToolHintAt = now;
          }
        } else {
          const failed = Boolean(payload.error);
          toolMessages.push(`${failed ? "✗" : "✓"} 工具 [${toolName}] ${failed ? "失败" : "完成"}`);
        }
        // 缓冲达到 2 条或进度条数超上限时先发一批
        if (toolMessages.length >= 2 || toolMessages.length >= config.replyProgressMax) {
          void this.flushToolMessages(contactId, toolMessages);
        }
      }

      // 分块流式：message_update 的 message 是完整快照，只取新增部分累积，达阈值发块
      if (type === "message_update" && config.blockStreaming) {
        const full = extractTextFromMessage(payload.message);
        if (full.length > lastTextLen) {
          const newPart = full.slice(lastTextLen);
          lastTextLen = full.length;
          streamBuffer += newPart;
          if (streamBuffer.length >= config.blockMinChars && blockSent < config.blockMaxMessages - 1) {
            const block = streamBuffer;
            streamBuffer = "";
            blockSent += 1;
            const chunks = splitWeixinMessage(block, config.blockMinChars);
            void transport.send(contactId, chunks[0] ?? block).catch(() => {});
          }
        }
      }

      // 最终回复：只收 assistant 角色的消息（Pi 对 user 消息也发 message_end）
      if (type === "message_end") {
        const msg = payload.message as { role?: string } | undefined;
        if (msg?.role !== "assistant") return;
        const extracted = extractTextFromMessage(payload.message);
        console.log(`[wechat] message_end extracted: ${JSON.stringify(extracted?.slice(0, 80))}`);
        if (extracted && !replySent.has(extracted)) {
          replySent.add(extracted);
          collected.push(extracted);
        }
      }
    });
    try {
      await runtimeManager.prompt(sessionId, text);
    } finally {
      unsubscribe();
    }
    // 剩余工具提示合并发送（不阻塞主回复）
    await this.flushToolMessages(contactId, toolMessages);
    const reply = collected.join("\n\n");
    console.log(`[wechat] promptAndCollect reply: ${JSON.stringify(reply?.slice(0, 80))}`);
    return reply;
  }

  /** 合并发送缓冲的工具提示/进度消息（避免刷屏与配额，照抄 nanobot _flush_tool_hints） */
  private async flushToolMessages(contactId: string, buffer: string[]): Promise<void> {
    if (buffer.length === 0) return;
    const text = buffer.splice(0, buffer.length).join("\n");
    try {
      await this.transport.send(contactId, text);
    } catch {
      // 工具提示失败不阻塞主流程
    }
  }

  /** /列表：列出最近会话 */
  private async listSessions(contactId: string): Promise<void> {
    const { router } = this.opts;
    const transport = this.transport;
    const sessions = await router.list();
    const recent = sessions.slice(0, this.recentCount);
    if (recent.length === 0) {
      await transport.send(contactId, "暂无会话。发送任意消息将自动创建新会话。");
      return;
    }
    const lines = recent.map((s, i) => {
      const title = s.title || s.sessionId.slice(0, 8);
      const tag = s.running ? "运行中" : "空闲";
      return `${i + 1}. ${title} [${tag}]`;
    });
    await transport.send(contactId, `最近会话：\n${lines.join("\n")}\n回复 /继续 <序号> 切换`);
  }

  /** /继续 <n>：切换绑定到指定会话 */
  private async switchSession(contactId: string, index: number): Promise<void> {
    const { router, metadata } = this.opts;
    const transport = this.transport;
    const sessions = await router.list();
    const target = sessions[index - 1];
    if (!target) {
      await transport.send(contactId, `序号无效（1-${Math.min(sessions.length, this.recentCount)}）。`);
      return;
    }
    const key = channelKey("wechat", contactId);
    metadata.setBinding("wechat", key, { activeSessionId: target.sessionId });
    await transport.send(contactId, `已切换到会话 ${target.title || target.sessionId.slice(0, 8)}…`);
  }
}
