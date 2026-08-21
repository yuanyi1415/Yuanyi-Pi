import { toClientAgentEvent, type AgentEventLike } from "./agent-event-wire";

const HEARTBEAT_INTERVAL_MS = 30_000;

interface GatewayEnvelope {
  sessionId: string;
  sequence: number;
  type: string;
  timestamp: number;
  requestId?: string;
  payload: unknown;
}

/**
 * Personal Gateway SSE 代理（DEV312 / DEV224 兼容层）
 *
 * 前端协议保持 Web 原样：先发 `connected`，再转发 Pi 原生事件（
 * Gateway envelope 解包 payload → toClientAgentEvent）。
 * 断线只终止代理连接，不终止 Gateway Runtime（技术设计 5.3）。
 */
export function createGatewayEventStream(
  req: Request,
  sessionId: string,
  openGateway: () => Promise<Response>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        try { controller.close(); } catch { /* already closed */ }
      };
      abortHandler = () => cleanup();
      if (req.signal.aborted) {
        cleanup();
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const encode = (data: unknown) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`);
      };
      // Gateway 先发送真实 state 快照；只有拿到快照后才能声明连接状态，
      // 否则重连中的流式会话会被错误标记为空闲。
      const connect = async () => {
        try {
          const gatewayRes = await openGateway();
          if (closed) {
            gatewayRes.body?.cancel().catch(() => {});
            return;
          }
          const reader = gatewayRes.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const parts = buf.split("\n\n");
              buf = parts.pop() ?? "";
              for (const part of parts) {
                const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
                if (!dataLine) continue;
                let envelope: GatewayEnvelope;
                try {
                  envelope = JSON.parse(dataLine.slice(6)) as GatewayEnvelope;
                } catch {
                  continue;
                }
                if (!envelope || typeof envelope.payload !== "object" || envelope.payload === null) {
                  continue;
                }
                if (envelope.type === "state") {
                  const state = envelope.payload as {
                    isStreaming?: boolean;
                    streamingMessage?: unknown;
                  };
                  encode({
                    type: "connected",
                    sessionId,
                    isStreaming: state.isStreaming === true,
                  });
                  if (state.streamingMessage !== undefined && state.streamingMessage !== null) {
                    encode({ type: "message_start", message: state.streamingMessage });
                  }
                  continue;
                }
                const clientEvent = toClientAgentEvent(envelope.payload as AgentEventLike);
                if (clientEvent) {
                  encode({
                    ...clientEvent,
                    ...(envelope.requestId
                      ? { requestId: envelope.requestId, gatewayEventAt: envelope.timestamp }
                      : {}),
                  });
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        } catch (err) {
          // Gateway 不可达：发 startup_error 后关闭（与 Web 原协议一致）
          console.error(
            "[pi-web] gateway event stream error:",
            err instanceof Error ? err.message : String(err),
          );
          if (!closed) {
            encode({
              type: "startup_error",
              errorMessage: "Failed to connect to Personal Gateway",
            });
          }
        } finally {
          cleanup();
        }
      };
      void connect();

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);
      enqueueText(":\n\n");
    },
    cancel() {
      // ReadableStream cancel：由 cleanup 处理（closed=true 使循环退出）
    },
  });
}
