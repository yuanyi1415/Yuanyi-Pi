/**
 * 微信 iLink 协议类型（照抄 nanobot weixin/runtime.py + types.ts）
 * 协议版本：openclaw-weixin v2.4.6
 */

/** MessageItemType */
export const ITEM_TEXT = 1;
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;
export const ITEM_TOOL_CALL_START = 11;
export const ITEM_TOOL_CALL_RESULT = 12;

/** MessageType：1 = 用户入站，2 = bot 出站 */
export const MESSAGE_TYPE_BOT = 2;

/** MessageState */
export const MESSAGE_STATE_FINISH = 2;

export const WEIXIN_MAX_MESSAGE_LEN = 1800;
export const WEIXIN_CHANNEL_VERSION = "2.4.6";
export const ILINK_APP_ID = "bot";

/** 业务错误码 */
export const ERRCODE_CONTEXT_RESTRICTED = -2;
export const ERRCODE_INVALID_ARGUMENT = -3;
export const ERRCODE_STALE_TOKEN = -14;

/** 长轮询默认超时（服务端可下发覆盖） */
export const DEFAULT_LONG_POLL_TIMEOUT_S = 35;
export const DEFAULT_API_TIMEOUT_S = 15;
export const DEFAULT_CONFIG_TIMEOUT_S = 10;
export const QR_POLL_TIMEOUT_S = 60;
export const MAX_QR_REFRESH_COUNT = 3;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const RETRY_DELAY_S = 2;
export const BACKOFF_DELAY_S = 30;
export const CONTEXT_TOKEN_MAX_AGE_S = 60;
export const CONTEXT_MESSAGE_BUDGET = 8;
export const MAX_DEFERRED_MESSAGES_PER_CHAT = 3;
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429]);
export const TYPING_STATUS_TYPING = 1;
export const TYPING_STATUS_CANCEL = 2;
export const TYPING_TICKET_TTL_S = 24 * 60 * 60;
export const TYPING_KEEPALIVE_INTERVAL_S = 5;
export const CONFIG_CACHE_INITIAL_RETRY_S = 2;
export const CONFIG_CACHE_MAX_RETRY_S = 60 * 60;

/** 编码语义版本 2.4.6 → 0x020406 */
export const ILINK_APP_CLIENT_VERSION =
  ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff);

/** BASE_INFO（getupdates/sendmessage/sendtyping/getconfig 均携带） */
export const BASE_INFO: Record<string, string> = {
  channel_version: WEIXIN_CHANNEL_VERSION,
  bot_agent: "yuanyi-pi/personal-runtime (typescript)",
};

/** 入站 item 结构 */
export interface WeixinTextItem {
  text?: string;
}
export interface WeixinMedia {
  encrypt_query_param?: string;
  full_url?: string;
  aes_key?: string;
  encrypt_type?: number;
}
export interface WeixinMediaItem {
  media?: WeixinMedia;
  file_name?: string;
  text?: string; // voice_item 的微信侧转写文本
}
export interface WeixinItem {
  type: number;
  text_item?: WeixinTextItem;
  image_item?: WeixinMediaItem;
  voice_item?: WeixinMediaItem;
  file_item?: WeixinMediaItem;
  video_item?: WeixinMediaItem;
  ref_msg?: WeixinRefMsg;
}

export interface WeixinRefMsg {
  title?: string;
  message_item?: WeixinItem;
}

/** 入站消息（getupdates msgs[]） */
export interface WeixinInboundMessage {
  message_id?: string;
  seq?: string;
  from_user_id?: string;
  message_type?: number;
  context_token?: string;
  create_time_ms?: number;
  item_list?: WeixinItem[];
}

/** getupdates 响应 */
export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  msgs?: WeixinInboundMessage[];
}

/** QR 登录状态 */
export type QrStatus =
  | "wait"
  | "confirmed"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect"
  | "expired";

export interface QrStatusResponse {
  status?: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

/** 出站文本消息 */
export interface WeixinOutboundText {
  toUserId: string;
  text: string;
  contextToken: string;
  clientId: string;
  runId?: string;
}

/** iLink API 错误（含重试契约） */
export class WeixinAPIError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret = 0,
    readonly errcode = 0,
    readonly errmsg = "",
    readonly retryable = false,
  ) {
    super(
      `WeChat ${endpoint} failed (ret=${ret}, errcode=${errcode}): ${errmsg || "no error message"}`,
    );
    this.name = "WeixinAPIError";
  }
}

/** context_token 配额受限（defer 等待新消息） */
export class WeixinQuotaError extends WeixinAPIError {}

/** token 失效，需重新扫码 */
export class WeixinAuthError extends WeixinAPIError {}
