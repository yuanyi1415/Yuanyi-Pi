// Personal Gateway BFF 客户端（DEV312）
//
// Pi Web 通过本模块把 Session 创建/命令/状态/列表转发到 Personal Runtime
// Gateway（HTTP JSON + SSE）。PERSONAL_GATEWAY_ENABLED=1 时启用；
// 旧 rpc-manager 仅允许 dev 显式打开，避免 Web 形成第二 Runtime Owner。

const GATEWAY_URL =
  process.env.PERSONAL_GATEWAY_URL ?? "http://127.0.0.1:8770";

export function gatewayEnabled(): boolean {
  return process.env.PERSONAL_GATEWAY_ENABLED === "1";
}

export function legacyRuntimeEnabled(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.ALLOW_LEGACY_RPC_RUNTIME === "1";
}

export function runtimeUnavailableResponse(): Response {
  return Response.json(
    { error: "runtime_unavailable", message: "Personal Runtime/Gateway is unavailable" },
    { status: 503, headers: { "Retry-After": "3" } },
  );
}

export interface GatewaySessionDescriptor {
  sessionId: string;
  title?: string;
  projectDirectory: string | null;
  projectDisplayName?: string;
  runtimeCwd: string;
  originChannel?: string;
  model?: { provider: string; modelId: string; presetId?: string };
  running: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface GatewayProject {
  path: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

async function gatewayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      (body && (body.error || body.message)) || `Gateway ${res.status}`,
    ) as Error & { status?: number; code?: string; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

/** 创建 Session（projectDirectory=null 表示无项目） */
export function gatewayCreateSession(input: {
  projectDirectory?: string | null;
  projectDisplayName?: string | null;
  model?: { provider: string; modelId: string; presetId?: string };
}): Promise<GatewaySessionDescriptor> {
  return gatewayFetch("/v1/sessions/prepare", {
    method: "POST",
    body: JSON.stringify({
      projectDirectory: input.projectDirectory ?? null,
      projectDisplayName: input.projectDisplayName ?? null,
      ...(input.model ? { model: input.model } : {}),
      originChannel: "web",
    }),
  });
}

export function gatewayListProjects(): Promise<{ projects: GatewayProject[] }> {
  return gatewayFetch("/v1/projects");
}

export function gatewayRenameProject(projectDirectory: string, displayName: string): Promise<GatewayProject> {
  return gatewayFetch("/v1/projects", {
    method: "PATCH",
    body: JSON.stringify({ projectDirectory, displayName }),
  });
}

export function gatewayRemoveProject(projectDirectory: string): Promise<{ ok: true }> {
  return gatewayFetch("/v1/projects", {
    method: "DELETE",
    body: JSON.stringify({ projectDirectory }),
  });
}

/** 发送 Session 命令 */
export function gatewayCommand(
  sessionId: string,
  command: Record<string, unknown>,
  trace?: { requestId?: string; t0?: string },
) {
  return gatewayFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
    method: "POST",
    body: JSON.stringify(command),
    headers: {
      ...(trace?.requestId ? { "X-Yuanyi-Request-Id": trace.requestId } : {}),
      ...(trace?.t0 ? { "X-Yuanyi-T0": trace.t0 } : {}),
    },
  });
}

/** 获取 Session 状态（running / state） */
export function gatewayGetSession(sessionId: string): Promise<GatewaySessionDescriptor> {
  return gatewayFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`);
}

export function gatewayDeleteSession(sessionId: string): Promise<{ ok: true }> {
  return gatewayFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export function gatewayGetSessionContext(sessionId: string, options: {
  leafId?: string;
  deferThinking?: boolean;
  deferMedia?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (options.leafId) params.set("leafId", options.leafId);
  if (options.deferThinking) params.set("deferThinking", "1");
  if (options.deferMedia) params.set("deferMedia", "1");
  const query = params.toString();
  return gatewayFetch<{ context: unknown }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/context${query ? `?${query}` : ""}`,
  );
}

export function gatewayGenerateSessionTitle(sessionId: string): Promise<{ title: string; usage?: unknown }> {
  return gatewayFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/title/generate`, { method: "POST" });
}

export function gatewayGetSessionDocument(sessionId: string, options: {
  leafId?: string;
  deferThinking?: boolean;
  deferMedia?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (options.leafId) params.set("leafId", options.leafId);
  if (options.deferThinking) params.set("deferThinking", "1");
  if (options.deferMedia) params.set("deferMedia", "1");
  const query = params.toString();
  return gatewayFetch<{
    filePath: string;
    info: Record<string, unknown>;
    leafId?: string | null;
    tree: unknown;
    totalActiveMs: number;
    context: unknown;
  }>(`/v1/sessions/${encodeURIComponent(sessionId)}/document${query ? `?${query}` : ""}`);
}

export function gatewayGetProjectTrust(cwd: string) {
  return gatewayFetch<{ requiresTrust: boolean; trusted: boolean }>(
    `/v1/project-trust?cwd=${encodeURIComponent(cwd)}`,
  );
}

export function gatewayTrustProject(cwd: string) {
  return gatewayFetch<{ requiresTrust: boolean; trusted: boolean }>("/v1/project-trust", {
    method: "POST",
    body: JSON.stringify({ cwd }),
  });
}

/** 列出全部 Session */
export function gatewayListSessions(): Promise<{ sessions: GatewaySessionDescriptor[] }> {
  return gatewayFetch("/v1/sessions");
}

/** 打开 Gateway SSE 流（返回 Response 透传给客户端） */
export async function gatewayEventStream(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(
    `${GATEWAY_URL}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    { signal },
  );
  if (!res.ok || !res.body) {
    throw new Error(`Gateway events ${res.status}`);
  }
  return res;
}

// ---------------- 渠道管理（FR-102） ----------------

export interface ChannelStatus {
  connected: boolean;
  running: boolean;
  account?: string;
  authExpired?: boolean;
}

export interface ChannelConnectPayload {
  session_id: string;
  status: string;
  qr_url?: string;
  message?: string;
  account?: string;
  interval_ms?: number;
  expires_at_ms?: number;
  challenge?: "verify_code";
  verification_failed?: boolean;
}

export function gatewayChannelStatus(): Promise<ChannelStatus> {
  return gatewayFetch("/v1/channels/wechat");
}

export function gatewayChannelConnectStart(force = false): Promise<ChannelConnectPayload> {
  return gatewayFetch("/v1/channels/wechat/connect", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export function gatewayChannelConnectPoll(
  sessionId: string,
  verifyCode = "",
): Promise<ChannelConnectPayload> {
  const params = new URLSearchParams({ session_id: sessionId });
  if (verifyCode) params.set("verify_code", verifyCode);
  return gatewayFetch(`/v1/channels/wechat/connect?${params.toString()}`);
}

export function gatewayChannelConnectCancel(sessionId: string): Promise<ChannelConnectPayload> {
  return gatewayFetch("/v1/channels/wechat/connect/cancel", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

/** 读取渠道配置 */
export function gatewayChannelConfig(): Promise<Record<string, unknown>> {
  return gatewayFetch("/v1/channels/wechat/config");
}

/** 保存渠道配置 */
export function gatewayChannelSaveConfig(partial: Record<string, unknown>): Promise<Record<string, unknown>> {
  return gatewayFetch("/v1/channels/wechat/config", {
    method: "PUT",
    body: JSON.stringify(partial),
  });
}

/** 断开连接（停止轮询，保留 token） */
export function gatewayChannelDisconnect(): Promise<ChannelStatus> {
  return gatewayFetch("/v1/channels/wechat/disconnect", { method: "POST", body: "{}" });
}

/** 重新连接（恢复轮询，免扫码） */
export function gatewayChannelReconnect(): Promise<ChannelStatus> {
  return gatewayFetch("/v1/channels/wechat/reconnect", { method: "POST", body: "{}" });
}
