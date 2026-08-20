/**
 * 一期共享契约类型（对应 Stage-001 附录 C-1 / C-3 / C-4）。
 * 契约版本随 Stage-001 走；实现与 Gateway/Channel 共用本文件。
 */

/** 模型选择（C-1）：运行事实落到 Pi Model State，presetId 仅作产品引用 */
export interface ModelSelection {
  provider: string;
  modelId: string;
  presetId?: string;
}

/** Thinking Level，与 Pi 语义一致（agent-session 的 ThinkingLevel） */
export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Session 描述（C-1） */
export interface SessionDescriptor {
  sessionId: string;
  title?: string;
  projectDirectory: string | null;
  runtimeCwd: string;
  originChannel?: "web" | "wechat";
  model?: ModelSelection;
  running: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** Gateway Event Envelope（C-3） */
export interface GatewayEvent {
  sessionId: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: unknown;
}

/** Runtime 瞬时状态（C-2） */
export interface SessionRuntimeState {
  state: "starting" | "ready" | "busy" | "disposing" | "error";
  isStreaming: boolean;
  isIdle: boolean;
  model?: ModelSelection;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
}

/** Session 命令面（C-2，保留 Pi Web 现有能力） */
export type SessionCommand =
  | { type: "prompt"; message: string }
  | { type: "abort" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "set_model"; model: ModelSelection }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "set_tools"; toolNames: string[] }
  | { type: "compact" }
  | { type: "get_state" };

/** Prompt 受理结果 */
export interface PromptAck {
  accepted: boolean;
  sessionId: string;
  reason?: "busy" | "error";
}

/** Channel 入站消息（C-4） */
export interface InboundChannelMessage {
  channelType: string;
  accountId: string;
  contactId: string;
  messageId: string;
  text: string;
  receivedAt: number;
}

/** Channel 出站地址 */
export interface ChannelAddress {
  accountId?: string;
  contactId: string;
}

/** Channel 出站消息 */
export interface OutboundMessage {
  text: string;
  sessionId?: string;
}
