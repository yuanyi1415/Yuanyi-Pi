/**
 * WechatChannelController（FR-102 后端）
 *
 * 渠道状态查询 + 扫码连接流程（照抄 nanobot connect.py）：
 * - status：已连接 / 运行中 / 失效
 * - connectStart / connectPoll / connectCancel：WebUI 驱动的扫码登录
 *   （get_bot_qrcode → get_qrcode_status 轮询 → confirmed 提交 token）
 *
 * 登录成功后 token 写入 account.json（与 CLI 登录共用），transport 通过
 * reloadReplacementToken 机制热采纳。
 */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { MAX_QR_REFRESH_COUNT, WeixinAuthError } from "./types";
import { IlinkClient, responseInt } from "./ilink";
import { WechatStateStore } from "./state";
import { ChannelConfigStore, type WechatChannelConfig } from "./config";

export type ConnectStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export interface ConnectPayload {
  session_id: string;
  status: ConnectStatus;
  qr_url?: string;
  message?: string;
  account?: string;
  interval_ms?: number;
  expires_at_ms?: number;
  /** 需验证码时下发 */
  challenge?: "verify_code";
  verification_failed?: boolean;
}

export interface ChannelStatusPayload {
  connected: boolean;
  running: boolean;
  account?: string;
  authExpired?: boolean;
}

interface ConnectSession {
  id: string;
  qrcodeId: string;
  qrUrl: string;
  baseUrl: string;
  refreshCount: number;
  force: boolean;
  deadline: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

export class WechatChannelController {
  private readonly sessions = new Map<string, ConnectSession>();
  private readonly stateStore: WechatStateStore;
  private readonly baseUrl: string;

  constructor(
    opts: {
      stateDir: string;
      baseUrl?: string;
      /** 当前是否运行中（transport 状态） */
      isRunning?: () => boolean;
      /** 当前是否 authExpired */
      isAuthExpired?: () => boolean;
      /** 渠道配置存储 */
      configStore?: ChannelConfigStore;
      /** 断开连接（停止 transport 轮询） */
      onDisconnect?: () => Promise<void>;
      /** 重新连接（恢复 transport 轮询） */
      onConnect?: () => Promise<void>;
    },
  ) {
    this.stateStore = new WechatStateStore(opts.stateDir);
    this.baseUrl = opts.baseUrl ?? "https://ilinkai.weixin.qq.com";
    this.isRunning = opts.isRunning ?? (() => false);
    this.isAuthExpired = opts.isAuthExpired ?? (() => false);
    this.configStore = opts.configStore ?? new ChannelConfigStore(dirname(opts.stateDir));
    this.onDisconnect = opts.onDisconnect ?? (async () => {});
    this.onConnect = opts.onConnect ?? (async () => {});
  }

  private readonly configStore: ChannelConfigStore;
  private readonly onDisconnect: () => Promise<void>;
  private readonly onConnect: () => Promise<void>;

  private readonly isRunning: () => boolean;
  private readonly isAuthExpired: () => boolean;

  /** 读取渠道配置 */
  getConfig(): WechatChannelConfig {
    return this.configStore.get();
  }

  /** 保存渠道配置（即时生效） */
  setConfig(partial: Partial<WechatChannelConfig>): WechatChannelConfig {
    return this.configStore.set(partial);
  }

  /** 断开连接：停止 transport 轮询（保留 token，可重新连接） */
  async disconnect(): Promise<ChannelStatusPayload> {
    await this.onDisconnect();
    return this.status();
  }

  /** 重新连接：恢复 transport 轮询（token 存在时免扫码） */
  async reconnect(): Promise<ChannelStatusPayload> {
    await this.onConnect();
    return this.status();
  }

  /** 渠道状态 */
  async status(): Promise<ChannelStatusPayload> {
    const state = this.stateStore.load();
    const connected = Boolean(state?.token);
    return {
      connected,
      running: this.isRunning(),
      account: state?.token ? accountOf(state.token) : undefined,
      authExpired: this.isAuthExpired(),
    };
  }

  /** 开始扫码连接 */
  async connectStart(force = false): Promise<ConnectPayload> {
    this.cleanup();
    if (!force && this.stateStore.load()?.token) {
      return {
        session_id: "",
        status: "succeeded",
        message: "WeChat is already connected.",
        interval_ms: POLL_INTERVAL_MS,
      };
    }
    const client = new IlinkClient({ baseUrl: this.baseUrl, pollTimeout: 35 });
    // 已有本地 token 时携带（服务端可能识别已绑定）
    const localTokens = force ? [] : this.localTokenList();
    const { qrcodeId, scanUrl } = await client.fetchQrCode(localTokens);
    const id = cryptoRandom();
    this.sessions.set(id, {
      id,
      qrcodeId,
      qrUrl: scanUrl,
      baseUrl: this.baseUrl,
      refreshCount: 0,
      force,
      deadline: Date.now() + SESSION_TTL_MS,
    });
    return {
      session_id: id,
      status: "pending",
      qr_url: scanUrl,
      interval_ms: POLL_INTERVAL_MS,
      expires_at_ms: Date.now() + SESSION_TTL_MS,
      message: "Scan with WeChat to connect.",
    };
  }

  /** 轮询扫码状态 */
  async connectPoll(sessionId: string, verifyCode = ""): Promise<ConnectPayload> {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { session_id: sessionId, status: "expired", message: "This WeChat login has expired. Start again." };
    }
    const client = new IlinkClient({ baseUrl: this.baseUrl, pollTimeout: 35 });
    const poll = async (): Promise<Record<string, unknown>> =>
      client.pollQrStatus(session.qrcodeId, session.baseUrl, verifyCode);

    let statusData: Record<string, unknown>;
    try {
      statusData = await poll();
    } catch (err) {
      // 可重试错误 → 保持 pending
      if (isRetryablePollError(err)) {
        return this.pending(session, "Waiting for WeChat scan.");
      }
      this.sessions.delete(sessionId);
      return { session_id: sessionId, status: "failed", message: `WeChat QR login failed: ${String(err)}` };
    }

    const status = String(statusData.status ?? "");
    console.log(`[wechat] connectPoll session=${sessionId.slice(0,6)} status=${status}`);
    const base = (payload: Partial<ConnectPayload> = {}): ConnectPayload => ({
      session_id: sessionId,
      status: "pending",
      qr_url: session.qrUrl,
      interval_ms: POLL_INTERVAL_MS,
      expires_at_ms: session.deadline,
      ...payload,
    });

    if (status === "confirmed") {
      console.log(`[wechat] connectPoll confirmed full: ${JSON.stringify(statusData).slice(0, 400)}`);
      const token = String(statusData.bot_token ?? "");
      if (!token) {
        this.sessions.delete(sessionId);
        return { session_id: sessionId, status: "failed", message: "WeChat confirmed the scan but returned no token." };
      }
      const newBaseUrl = String(statusData.baseurl ?? "") || this.baseUrl;
      // 提交 token（扫码权威 token，force 跳过防覆盖——nanobot _commit_account 同策略）
      this.stateStore.save(
        token,
        "",
        {},
        newBaseUrl,
        "",
        true,
      );
      // 用新 token 重启 transport（旧 token 的轮询已停止）
      try {
        await this.onDisconnect();
        await this.onConnect();
      } catch (err) {
        console.error("[wechat] reconnect after QR login failed:", err);
      }
      this.sessions.delete(sessionId);
      return {
        session_id: sessionId,
        status: "succeeded",
        message: "WeChat is connected.",
        account: String(statusData.ilink_user_id ?? ""),
      };
    }

    if (status === "scaned_but_redirect") {
      const redirectHost = String(statusData.redirect_host ?? "").trim();
      if (redirectHost) {
        session.baseUrl = redirectHost.startsWith("http") ? redirectHost : `https://${redirectHost}`;
      }
      return base();
    }

    if (status === "need_verifycode") {
      return base({
        challenge: "verify_code",
        message: verifyCode
          ? "That verification code did not match. Enter the new number shown in WeChat."
          : "Enter the number shown in WeChat to continue.",
        verification_failed: Boolean(verifyCode),
      });
    }

    if (status === "verify_code_blocked") {
      session.refreshCount += 1;
      if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
        this.sessions.delete(sessionId);
        return { session_id: sessionId, status: "failed", message: "Too many incorrect verification attempts. Try again later." };
      }
      return this.refreshQr(session, base);
    }

    if (status === "binded_redirect") {
      if (session.force) {
        this.sessions.delete(sessionId);
        return {
          session_id: sessionId,
          status: "failed",
          message: "Unable to complete a new WeChat login. Start again and scan with the account you want to connect.",
        };
      }
      if (this.stateStore.load()?.token) {
        this.sessions.delete(sessionId);
        return { session_id: sessionId, status: "succeeded", message: "WeChat is already connected." };
      }
      this.sessions.delete(sessionId);
      return {
        session_id: sessionId,
        status: "failed",
        message: "WeChat reports an existing binding, but no local credentials were found.",
      };
    }

    if (status === "expired") {
      session.refreshCount += 1;
      if (session.refreshCount > MAX_QR_REFRESH_COUNT) {
        this.sessions.delete(sessionId);
        return { session_id: sessionId, status: "expired", message: "This WeChat QR code expired. Start again." };
      }
      return this.refreshQr(session, base);
    }

    // status == "wait" → 继续轮询
    return base();
  }

  /** 取消连接 */
  async connectCancel(sessionId: string): Promise<ConnectPayload> {
    this.sessions.delete(sessionId);
    return { session_id: sessionId, status: "cancelled", message: "WeChat login cancelled." };
  }

  // ------------------------------------------------------------------

  private async refreshQr(
    session: ConnectSession,
    base: (payload?: Partial<ConnectPayload>) => ConnectPayload,
  ): Promise<ConnectPayload> {
    const client = new IlinkClient({ baseUrl: this.baseUrl, pollTimeout: 35 });
    try {
      const { qrcodeId, scanUrl } = await client.fetchQrCode(
        session.force ? [] : this.localTokenList(),
      );
      session.qrcodeId = qrcodeId;
      session.qrUrl = scanUrl;
      session.baseUrl = this.baseUrl;
      return base({ qr_url: scanUrl });
    } catch {
      return base({ message: "Could not refresh WeChat QR code." });
    }
  }

  private localTokenList(): string[] {
    const state = this.stateStore.load();
    return state?.token ? [state.token] : [];
  }

  private pending(
    session: ConnectSession,
    message: string,
  ): ConnectPayload {
    return {
      session_id: session.id,
      status: "pending",
      qr_url: session.qrUrl,
      interval_ms: POLL_INTERVAL_MS,
      expires_at_ms: session.deadline,
      message,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now >= session.deadline) this.sessions.delete(id);
    }
  }
}

function accountOf(token: string): string {
  // token 形如 "xxx@im.bot:..."; 取 @ 前段作为 account 展示
  return token.split("@")[0] || token.slice(0, 8);
}

function cryptoRandom(): string {
  return randomBytes(18).toString("base64url");
}

function isRetryablePollError(err: unknown): boolean {
  if (err instanceof Error && "status" in err) {
    return IlinkClient.isRetryableHttpStatus((err as Error & { status: number }).status);
  }
  return true;
}
