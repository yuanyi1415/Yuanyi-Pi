/**
 * 微信 Channel：WeChatTransport + WechatChannelAdapter（照抄 nanobot ilinkai 机制）。
 * 一期：私聊文本收发 + Session Binding。
 */
export { WeChatTransport } from "./transport";
export type {
  WechatInboundMessage,
  WechatSendResult,
  WechatTransportConfig,
  WechatTransportHooks,
} from "./transport";
export { WechatChannelAdapter } from "./adapter";
export type { WechatAdapterOptions } from "./adapter";
export {
  sanitizeWeixinMarkdown,
  splitWeixinMessage,
  parseItemListToContent,
} from "./format";
export { qrLogin } from "./login";
export type { QrLoginOptions, QrLoginResult } from "./login";
export { WechatStateStore } from "./state";
export type { WechatAccountState } from "./state";
export { IlinkClient } from "./ilink";
export {
  WeixinAPIError,
  WeixinAuthError,
  WeixinQuotaError,
  ERRCODE_STALE_TOKEN,
  ERRCODE_CONTEXT_RESTRICTED,
} from "./types";
