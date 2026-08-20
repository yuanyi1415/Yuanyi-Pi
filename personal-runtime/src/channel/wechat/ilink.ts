/**
 * 微信 iLink HTTP 客户端（照抄 nanobot runtime.py HTTP helpers / api.ts）
 * - Headers：X-WECHAT-UIN（每次随机）、iLink-App-Id/ClientVersion、Bearer token
 * - 错误解析：ret/errcode → 业务错误（-2 配额 / -14 token 失效）
 * - 超时：getupdates 长轮询单独处理
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  BASE_INFO,
  DEFAULT_API_TIMEOUT_S,
  DEFAULT_CONFIG_TIMEOUT_S,
  ERRCODE_CONTEXT_RESTRICTED,
  ERRCODE_INVALID_ARGUMENT,
  ERRCODE_STALE_TOKEN,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  QR_POLL_TIMEOUT_S,
  RETRYABLE_HTTP_STATUS,
  WeixinAPIError,
  WeixinAuthError,
  WeixinQuotaError,
} from "./types";

export interface IlinkConfig {
  baseUrl: string;
  routeTag?: string | null;
  /** 长轮询超时（秒） */
  pollTimeout: number;
}

export class IlinkClient {
  private token = "";
  /** 长轮询超时，服务端可通过 longpolling_timeout_ms 覆盖 */
  nextPollTimeout: number;

  constructor(private readonly config: IlinkConfig) {
    this.nextPollTimeout = config.pollTimeout;
  }

  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string {
    return this.token;
  }

  /** X-WECHAT-UIN：随机 uint32 → 十进制 → base64（每次请求新生成，照抄 nanobot） */
  private randomWechatUin(): string {
    const uint32 = randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32)).toString("base64");
  }

  private headers(auth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "X-WECHAT-UIN": this.randomWechatUin(),
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    };
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.config.routeTag) {
      headers.SKRouteTag = String(this.config.routeTag);
    }
    return headers;
  }

  private requestTimeout(endpoint: string): number {
    if (endpoint.endsWith("getupdates")) return this.nextPollTimeout + 10;
    if (endpoint.endsWith("get_qrcode_status")) return QR_POLL_TIMEOUT_S;
    if (
      endpoint.endsWith("getconfig") ||
      endpoint.endsWith("sendtyping") ||
      endpoint.endsWith("notifystart") ||
      endpoint.endsWith("notifystop")
    ) {
      return DEFAULT_CONFIG_TIMEOUT_S;
    }
    return DEFAULT_API_TIMEOUT_S;
  }

  private async requestJson(
    method: "GET" | "POST",
    url: string,
    opts: {
      endpoint: string;
      params?: Record<string, string>;
      body?: unknown;
      headers: Record<string, string>;
    },
  ): Promise<Record<string, unknown>> {
    const urlObj = new URL(url);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) urlObj.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await fetch(urlObj, {
        method,
        headers: opts.headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeout(opts.endpoint) * 1000),
        redirect: "follow",
      });
    } catch (err) {
      // fetch 网络/超时错误直接抛出（调用方按重试策略处理）
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new WeixinAPIError(opts.endpoint, 0, 0, "server returned invalid JSON", true);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new WeixinAPIError(opts.endpoint, 0, 0, "server returned a non-object JSON payload", true);
    }
    return data as Record<string, unknown>;
  }

  private async apiGet(
    endpoint: string,
    params?: Record<string, string>,
    opts: { auth?: boolean; baseUrl?: string } = {},
  ): Promise<Record<string, unknown>> {
    const base = opts.baseUrl ?? this.config.baseUrl;
    const url = `${base.replace(/\/+$/, "")}/${endpoint}`;
    return this.requestJson("GET", url, {
      endpoint,
      params,
      headers: this.headers(opts.auth ?? true),
    });
  }

  private async apiPost(
    endpoint: string,
    body?: Record<string, unknown>,
    opts: { auth?: boolean; includeBaseInfo?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/${endpoint}`;
    const payload: Record<string, unknown> = { ...(body ?? {}) };
    if (opts.includeBaseInfo !== false && !("base_info" in payload)) {
      payload.base_info = BASE_INFO;
    }
    return this.requestJson("POST", url, {
      endpoint,
      body: payload,
      headers: this.headers(opts.auth ?? true),
    });
  }

  /** 解析 ret/errcode 并抛对应错误（照抄 _raise_for_api_error） */
  static raiseForApiError(endpoint: string, data: Record<string, unknown>): void {
    const ret = responseInt(data, "ret");
    const errcode = responseInt(data, "errcode");
    if (ret === 0 && errcode === 0) return;
    const errmsg = String(data.errmsg ?? "");
    if (errcode === ERRCODE_CONTEXT_RESTRICTED || ret === ERRCODE_CONTEXT_RESTRICTED) {
      throw new WeixinQuotaError(
        endpoint, ret, errcode, errmsg || "context token expired, quota exhausted, or sending restricted",
      );
    }
    if (errcode === ERRCODE_STALE_TOKEN || ret === ERRCODE_STALE_TOKEN) {
      throw new WeixinAuthError(endpoint, ret, errcode, errmsg || "bot token is stale; scan a new QR code");
    }
    if (errcode === ERRCODE_INVALID_ARGUMENT || ret === ERRCODE_INVALID_ARGUMENT) {
      throw new WeixinAPIError(endpoint, ret, errcode, errmsg, false);
    }
    throw new WeixinAPIError(endpoint, ret, errcode, errmsg);
  }

  // ---------------- 协议端点 ----------------

  /** 获取二维码（无认证，不带 base_info） */
  async fetchQrCode(localTokenList: string[]): Promise<{ qrcodeId: string; scanUrl: string }> {
    const data = await this.apiPost(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: localTokenList },
      { auth: false, includeBaseInfo: false },
    );
    IlinkClient.raiseForApiError("get_bot_qrcode", data);
    const qrcodeId = String(data.qrcode ?? "");
    if (!qrcodeId) throw new Error(`Failed to get QR code from WeChat API: ${JSON.stringify(data)}`);
    const img = String(data.qrcode_img_content ?? "");
    return { qrcodeId, scanUrl: img || qrcodeId };
  }

  /** 轮询扫码状态（无认证，支持重定向 base_url） */
  async pollQrStatus(
    qrcodeId: string,
    baseUrl: string,
    verifyCode = "",
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { qrcode: qrcodeId };
    if (verifyCode) params.verify_code = verifyCode;
    return this.apiGet("ilink/bot/get_qrcode_status", params, { auth: false, baseUrl });
  }

  /** 长轮询接收消息 */
  async getUpdates(getUpdatesBuf: string): Promise<Record<string, unknown>> {
    return this.apiPost("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf });
  }

  /** 发送消息 */
  async sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.apiPost("ilink/bot/sendmessage", { msg });
  }

  /** getconfig：typing_ticket / context_token 刷新 */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<Record<string, unknown>> {
    return this.apiPost("ilink/bot/getconfig", {
      ilink_user_id: ilinkUserId,
      context_token: contextToken ?? null,
    });
  }

  /** sendtyping */
  async sendTyping(ilinkUserId: string, ticket: string, status: number): Promise<Record<string, unknown>> {
    return this.apiPost("ilink/bot/sendtyping", {
      ilink_user_id: ilinkUserId,
      typing_ticket: ticket,
      status,
    });
  }

  /** 上线/下线通知（best-effort） */
  async notifyLifecycle(action: "start" | "stop"): Promise<void> {
    if (!this.token) return;
    const endpoint = `ilink/bot/msg/notify${action}`;
    try {
      const data = await this.apiPost(endpoint, {});
      IlinkClient.raiseForApiError(endpoint, data);
    } catch (err) {
      // best-effort：失败忽略
    }
  }

  static isRetryableHttpStatus(status: number): boolean {
    return RETRYABLE_HTTP_STATUS.has(status) || status >= 500;
  }
}

export function responseInt(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const n = Number(String(value ?? "0"));
  return Number.isNaN(n) ? 0 : n;
}

export function newClientId(prefix = "yuanyi"): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
