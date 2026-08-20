/**
 * WeChatTransport（照抄 nanobot WeixinChannel 核心机制）
 *
 * - 生命周期：start（加载/扫码登录 → notifystart → 长轮询循环）/ stop（notifystop + 保存状态）
 * - 接收：getupdates 长轮询 + get_updates_buf 游标续传 + message_id 去重
 * - 发送：context_token（60s 过期前 getconfig 主动刷新）+ 每上下文配额 + defer 重发
 * - 重连：超时正常续轮询；连续 3 次失败退避 30s；token 失效（-14）热替换或停止
 * - 一期范围：私聊文本（返回格式照抄 nanobot，见 format.ts）
 */
import {
  BACKOFF_DELAY_S,
  CONFIG_CACHE_INITIAL_RETRY_S,
  CONFIG_CACHE_MAX_RETRY_S,
  CONTEXT_MESSAGE_BUDGET,
  CONTEXT_TOKEN_MAX_AGE_S,
  ERRCODE_STALE_TOKEN,
  MAX_CONSECUTIVE_FAILURES,
  MAX_DEFERRED_MESSAGES_PER_CHAT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
  RETRY_DELAY_S,
  TYPING_KEEPALIVE_INTERVAL_S,
  TYPING_STATUS_CANCEL,
  TYPING_STATUS_TYPING,
  TYPING_TICKET_TTL_S,
  WeixinAuthError,
  WeixinQuotaError,
  type GetUpdatesResponse,
  type WeixinInboundMessage,
} from "./types";
import { IlinkClient, newClientId, responseInt } from "./ilink";
import { parseItemListToContent, splitWeixinMessage } from "./format";
import { qrLogin, type QrLoginOptions } from "./login";
import { WechatStateStore } from "./state";
import { ChannelConfigStore } from "./config";

export interface WechatTransportConfig {
  /** 默认 https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** 手动配置 token（可选，优先用本地扫码登录状态） */
  token?: string;
  /** account.json 状态目录 */
  stateDir: string;
  /** 长轮询超时（秒，默认 35） */
  pollTimeout?: number;
  /** 每 context_token 发送配额（默认 8） */
  contextMessageBudget?: number;
  /** 授权联系人（空 = 全部接受） */
  allowFrom?: string[];
  /** QR 登录交互回调（打印二维码等） */
  qrLogin?: Omit<QrLoginOptions, "force">;
}

export interface WechatInboundMessage {
  channelType: "wechat";
  contactId: string;
  messageId: string;
  text: string;
  receivedAt: number;
}

export interface WechatTransportHooks {
  onMessage: (msg: WechatInboundMessage) => Promise<void>;
  /** token 失效且无法热替换（需重新扫码） */
  onAuthExpired?: () => void;
}

export interface WechatSendResult {
  ok: boolean;
  deferred?: boolean;
}

export class WeChatTransport {
  private client: IlinkClient;
  private stateStore: WechatStateStore;
  private token = "";
  private getUpdatesBuf = "";
  private baseUrl: string;
  private readonly contextTokens = new Map<string, string>();
  private readonly contextTokenAt = new Map<string, number>();
  private readonly contextSendCounts = new Map<string, number>();
  private readonly processedIds = new Set<string>();
  private readonly deferred = new Map<string, Map<string, { toUserId: string; text: string }>>();
  private readonly typingTickets = new Map<string, { ticket: string; nextFetchAt: number; retryDelay: number }>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private authRequired = false;
  private readonly allowFrom: string[];
  private readonly budget: number;

  constructor(
    private readonly config: WechatTransportConfig,
    private readonly hooks: WechatTransportHooks,
    private readonly configStore?: ChannelConfigStore,
  ) {
    this.baseUrl = config.baseUrl ?? "https://ilinkai.weixin.qq.com";
    this.client = new IlinkClient({ baseUrl: this.baseUrl, pollTimeout: config.pollTimeout ?? 35 });
    this.stateStore = new WechatStateStore(config.stateDir, config.token);
    this.allowFrom = config.allowFrom ?? [];
    this.budget = config.contextMessageBudget ?? CONTEXT_MESSAGE_BUDGET;
  }

  getStateDir(): string {
    return this.config.stateDir;
  }

  // ------------------------------------------------------------------
  // 生命周期（照抄 start/stop）
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    const loaded = this.stateStore.load(
      this.config.token ? this.config.token : undefined,
    );
    if (this.config.token) {
      if (!loaded || loaded.replacedConfigTokenHash !== WechatStateStore.tokenFingerprint(this.config.token)) {
        this.token = this.config.token;
      } else {
        this.token = loaded.token;
      }
    } else if (loaded) {
      this.token = loaded.token;
      this.getUpdatesBuf = loaded.getUpdatesBuf;
      for (const [k, v] of Object.entries(loaded.contextTokens)) this.contextTokens.set(k, v);
      if (loaded.baseUrl) {
        this.baseUrl = loaded.baseUrl;
        this.client = new IlinkClient({
          baseUrl: this.baseUrl,
          pollTimeout: this.config.pollTimeout ?? 35,
        });
      }
    }
    this.client.setToken(this.token);

    if (!this.token) {
      const result = await qrLogin(this.client, this.baseUrl, {
        ...(this.config.qrLogin ?? {}),
      });
      if (!result.ok || !result.token) {
        this.running = false;
        if (result.reason !== "already_bound" && result.reason !== "cancelled") {
          throw new Error(`WeChat QR login failed: ${result.reason}`);
        }
        throw new Error(`WeChat login failed: ${result.reason ?? "no token"}`);
      }
      this.token = result.token;
      this.client.setToken(this.token);
      if (result.baseUrl) {
        this.baseUrl = result.baseUrl;
        this.client = new IlinkClient({
          baseUrl: this.baseUrl,
          pollTimeout: this.config.pollTimeout ?? 35,
        });
        this.client.setToken(this.token);
      }
      this.stateStore.save(
        this.token, this.getUpdatesBuf, Object.fromEntries(this.contextTokens),
        this.baseUrl, "",
      );
    }

    await this.client.notifyLifecycle("start");
    // 长轮询作为后台任务（start() 不阻塞，调用方决定何时 stop）
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.client.notifyLifecycle("stop");
    this.saveState();
  }

  isRunning(): boolean {
    // token 失效时不算运行中（前端据此后显示扫码/重连而非断开）
    return this.running && !this.authRequired;
  }

  /** token 是否已失效（需重新扫码） */
  isAuthExpired(): boolean {
    return this.authRequired;
  }

  // ------------------------------------------------------------------
  // 轮询（照抄 start 的 poll loop + _poll_once）
  // ------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        consecutiveFailures = 0;
      } catch (err) {
        if (!this.running) break;
        if (isTimeoutError(err)) continue; // 长轮询正常超时
        if (err instanceof WeixinAuthError) {
          this.running = false;
          this.hooks.onAuthExpired?.();
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_S * 1000);
        } else {
          await sleep(RETRY_DELAY_S * 1000);
        }
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const data = (await this.client.getUpdates(this.getUpdatesBuf)) as GetUpdatesResponse;
    try {
      IlinkClient.raiseForApiError("getupdates", data as unknown as Record<string, unknown>);
    } catch (err) {
      if (err instanceof WeixinAuthError) {
        // token 失效：尝试热替换（重新加载本地更新 token）
        if (this.reloadReplacementToken()) {
          await this.client.notifyLifecycle("start");
          return;
        }
        this.authRequired = true;
        throw err;
      }
      throw err;
    }

    // 服务端下发长轮询超时（monitor.ts:102-105）
    const serverTimeout = data.longpolling_timeout_ms;
    if (serverTimeout && serverTimeout > 0) {
      this.client.nextPollTimeout = Math.max(Math.floor(serverTimeout / 1000), 5);
    }

    const newBuf = data.get_updates_buf;
    if (newBuf) {
      this.getUpdatesBuf = newBuf;
      this.saveState();
    }

    for (const msg of data.msgs ?? []) {
      try {
        await this.processMessage(msg);
      } catch (err) {
        // 单条消息处理失败不中断轮询
      }
    }
  }

  /** 热替换失效 token（照抄 _reload_replacement_token） */
  private reloadReplacementToken(): boolean {
    const previous = this.token;
    const loaded = this.stateStore.load(this.config.token ? this.config.token : undefined);
    if (!loaded || loaded.token === previous) {
      this.token = previous;
      return false;
    }
    this.token = loaded.token;
    this.client.setToken(this.token);
    this.getUpdatesBuf = loaded.getUpdatesBuf;
    this.authRequired = false;
    return true;
  }

  // ------------------------------------------------------------------
  // 入站消息处理（照抄 _process_message，一期文本 + 媒体占位）
  // ------------------------------------------------------------------

  private async processMessage(msg: WeixinInboundMessage): Promise<void> {
    // 跳过 bot 自己的消息（message_type 2）
    if (msg.message_type === MESSAGE_TYPE_BOT) return;

    const msgId = String(msg.message_id ?? msg.seq ?? "");
    const fromUserId = String(msg.from_user_id ?? "");
    if (!msgId && !fromUserId) return;
    const dedupKey = msgId || `${fromUserId}_${msg.create_time_ms ?? ""}`;
    if (this.processedIds.has(dedupKey)) return;
    this.processedIds.add(dedupKey);
    while (this.processedIds.size > 1000) {
      const first = this.processedIds.values().next().value;
      if (first !== undefined) this.processedIds.delete(first);
    }
    if (!fromUserId) return;

    const ctxToken = String(msg.context_token ?? "");

    // 未授权联系人：一期直接拒绝（不进入 Agent）；allowFrom 优先取运行时配置
    const allowList = this.configStore?.get().allowFrom ?? this.allowFrom;
    if (allowList.length > 0 && !allowList.includes(fromUserId)) {
      return;
    }

    // 缓存 context_token（回复必需）
    if (ctxToken) {
      const previous = this.contextTokens.get(fromUserId) ?? "";
      this.contextTokens.set(fromUserId, ctxToken);
      this.contextTokenAt.set(fromUserId, Date.now());
      if (ctxToken !== previous) this.contextSendCounts.set(ctxToken, 0);
      this.saveState();
      await this.retryDeferred(fromUserId);
    }

    // item_list → 统一文本（照抄 nanobot 返回格式）
    const content = parseItemListToContent(msg.item_list ?? []);
    if (!content) return;

    await this.hooks.onMessage({
      channelType: "wechat",
      contactId: fromUserId,
      messageId: dedupKey,
      text: content,
      receivedAt: msg.create_time_ms ?? Date.now(),
    }).catch((err) => {
      console.error("[wechat] handleInbound failed:", err instanceof Error ? err.stack ?? err.message : err);
    });
  }

  // ------------------------------------------------------------------
  // 发送（照抄 send / _send_text，一期文本）
  // ------------------------------------------------------------------

  async send(toUserId: string, text: string): Promise<WechatSendResult> {
    if (!this.running || !this.token) {
      throw new Error("WeChat transport not initialized or not authenticated");
    }
    this.assertSessionActive();

    const content = text.trim();
    if (!content) return { ok: false };

    let ctxToken = this.contextTokens.get(toUserId) ?? "";
    ctxToken = await this.refreshContextTokenIfStale(toUserId, ctxToken);
    if (!ctxToken) {
      throw new WeixinQuotaError(
        "sendmessage", 0, ERRCODE_STALE_TOKEN,
        `context_token missing for chat_id=${toUserId}`,
      );
    }

    try {
      for (const chunk of splitWeixinMessage(content)) {
        await this.sendTextChunk(toUserId, chunk, ctxToken);
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof WeixinQuotaError) {
        this.deferOutbound(toUserId, text);
        return { ok: false, deferred: true };
      }
      if (err instanceof WeixinAuthError) {
        this.authRequired = true;
        throw err;
      }
      throw err;
    }
  }

  private async sendTextChunk(toUserId: string, chunk: string, ctxToken: string): Promise<void> {
    this.ensureContextBudget(ctxToken);
    const weixinMsg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: newClientId(),
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: 1, text_item: { text: chunk } }],
      context_token: ctxToken,
    };
    console.log(`[wechat] send to ${toUserId}: ${chunk.slice(0, 120)}`);
    const data = await this.client.sendMessage(weixinMsg);
    IlinkClient.raiseForApiError("sendmessage", data);
    this.recordContextSend(ctxToken);
  }

  private ensureContextBudget(ctxToken: string): void {
    const used = this.contextSendCounts.get(ctxToken) ?? 0;
    if (used + 1 <= this.budget) return;
    throw new WeixinQuotaError(
      "sendmessage", 0, -2,
      "local safety budget exhausted for this context token; wait for the user to send another message",
    );
  }

  private recordContextSend(ctxToken: string): void {
    if (ctxToken) {
      this.contextSendCounts.set(ctxToken, (this.contextSendCounts.get(ctxToken) ?? 0) + 1);
    }
  }

  /** context_token 超过 60s → getconfig 主动刷新（照抄 _refresh_context_token_if_stale） */
  private async refreshContextTokenIfStale(chatId: string, ctxToken: string): Promise<string> {
    if (!ctxToken) return ctxToken;
    const ageMs = Date.now() - (this.contextTokenAt.get(chatId) ?? 0);
    if (ageMs < CONTEXT_TOKEN_MAX_AGE_S * 1000) return ctxToken;

    try {
      const data = await this.client.getConfig(chatId, ctxToken);
      if (responseInt(data, "ret") !== 0 || responseInt(data, "errcode") !== 0) {
        return ctxToken;
      }
      const newToken = String(data.context_token ?? "");
      if (newToken && newToken !== ctxToken) {
        this.contextTokens.set(chatId, newToken);
        this.contextTokenAt.set(chatId, Date.now());
        this.saveState();
        return newToken;
      }
    } catch {
      // getconfig 失败用旧 token
    }
    return ctxToken;
  }

  // ------------------------------------------------------------------
  // 配额耗尽 → defer（照抄 _defer_outbound / _retry_deferred_messages）
  // ------------------------------------------------------------------

  private deferOutbound(chatId: string, text: string): void {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pending = this.deferred.get(chatId) ?? new Map();
    pending.set(key, { toUserId: chatId, text });
    this.deferred.set(chatId, pending);
    // 最多 defer 3 条/chat，超出丢最旧
    while (pending.size > MAX_DEFERRED_MESSAGES_PER_CHAT) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
  }

  private async retryDeferred(chatId: string): Promise<void> {
    const pending = this.deferred.get(chatId);
    if (!pending) return;
    for (const [key, item] of [...pending.entries()]) {
      try {
        await this.send(item.toUserId, item.text);
        pending.delete(key);
      } catch (err) {
        if (err instanceof WeixinQuotaError) break;
        pending.delete(key);
      }
    }
    if (pending.size === 0) this.deferred.delete(chatId);
  }

  // ------------------------------------------------------------------
  // 其它
  // ------------------------------------------------------------------

  private assertSessionActive(): void {
    if (this.authRequired) {
      throw new WeixinAuthError("sendmessage", 0, ERRCODE_STALE_TOKEN, "bot token is stale; scan a new QR code");
    }
  }

  // ------------------------------------------------------------------
  // typing 指示（FR-101，照抄 nanobot _start_typing/_stop_typing）
  // ------------------------------------------------------------------

  /** 开始"正在输入"（先停旧的，再 getconfig 拿 ticket → sendtyping(1) + 5s keepalive） */
  async startTyping(chatId: string): Promise<void> {
    if (!this.running || !this.token || !chatId) return;
    await this.stopTyping(chatId, false);
    try {
      const ticket = await this.getTypingTicket(chatId);
      if (!ticket) return;
      await this.sendTypingStatus(chatId, ticket, TYPING_STATUS_TYPING);
      const timer = setInterval(() => {
        void this.sendTypingStatus(chatId, ticket, TYPING_STATUS_TYPING).catch(() => {});
      }, TYPING_KEEPALIVE_INTERVAL_S * 1000);
      timer.unref();
      const existing = this.typingTimers.get(chatId);
      if (existing) clearInterval(existing);
      this.typingTimers.set(chatId, timer);
    } catch {
      // best-effort：ticket 失败静默跳过（不阻塞回复）
    }
  }

  /** 取消"正在输入"（sendtyping(2)，clearRemote=false 时仅停 keepalive） */
  async stopTyping(chatId: string, clearRemote = true): Promise<void> {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
    if (!clearRemote) return;
    const ticket = this.typingTickets.get(chatId)?.ticket ?? "";
    if (!ticket) return;
    try {
      await this.sendTypingStatus(chatId, ticket, TYPING_STATUS_CANCEL);
    } catch {
      // best-effort
    }
  }

  /** 获取 typing_ticket（缓存 24h，失败指数退避，照抄 nanobot _get_typing_ticket） */
  private async getTypingTicket(chatId: string): Promise<string> {
    const now = Date.now();
    const entry = this.typingTickets.get(chatId);
    if (entry && now < entry.nextFetchAt) return entry.ticket;
    try {
      const ctxToken = this.contextTokens.get(chatId) ?? "";
      const data = await this.client.getConfig(chatId, ctxToken || undefined);
      if (responseInt(data, "ret") === 0 && responseInt(data, "errcode") === 0) {
        const ticket = String(data.typing_ticket ?? "");
        this.typingTickets.set(chatId, {
          ticket,
          nextFetchAt: now + TYPING_TICKET_TTL_S * 1000,
          retryDelay: CONFIG_CACHE_INITIAL_RETRY_S * 1000,
        });
        return ticket;
      }
    } catch {
      // 失败走退避
    }
    const prevDelay = entry?.retryDelay ?? CONFIG_CACHE_INITIAL_RETRY_S * 1000;
    const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_S * 1000);
    this.typingTickets.set(chatId, {
      ticket: entry?.ticket ?? "",
      nextFetchAt: now + nextDelay,
      retryDelay: nextDelay,
    });
    return entry?.ticket ?? "";
  }

  private async sendTypingStatus(chatId: string, ticket: string, status: number): Promise<void> {
    const data = await this.client.sendTyping(chatId, ticket, status);
    IlinkClient.raiseForApiError("sendtyping", data);
  }

  private saveState(): void {
    this.stateStore.save(
      this.token,
      this.getUpdatesBuf,
      Object.fromEntries(this.contextTokens),
      this.baseUrl,
    );
  }
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  if (err instanceof Error && /timed out|timeout/i.test(err.message)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
