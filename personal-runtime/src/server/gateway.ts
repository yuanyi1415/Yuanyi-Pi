/**
 * Personal Gateway（DEV222 / DEV223 / DEV224）
 *
 * 一期统一三类接口（技术设计 3.1）：
 * - Session Query：GET /v1/sessions、GET /v1/sessions/{id}、POST /v1/sessions
 * - Session Command：POST /v1/sessions/{id}/commands
 * - Session Event：GET /v1/sessions/{id}/events（SSE）
 *
 * 零框架：Node 原生 http。SSE 断线不终止 Runtime（技术设计 5.3）。
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { SessionRouter } from "../session/router";
import type { RuntimeManager } from "../runtime/manager";
import type { SessionCommand, GatewayEvent } from "../contracts";
import type { WechatChannelController } from "../channel/wechat/controller";

type JsonObject = Record<string, unknown>;

export class Gateway {
  constructor(
    private readonly router: SessionRouter,
    private readonly runtimeManager: RuntimeManager,
    private readonly wechatController?: WechatChannelController,
  ) {}

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/v1/sessions") {
        const list = await this.router.list();
        return sendJson(res, 200, { sessions: list });
      }

      const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
      const commandMatch = path.match(/^\/v1\/sessions\/([^/]+)\/commands$/);
      const eventMatch = path.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1];
        // Runtime 激活时直接返回（新建未落盘 Session 也应为 running）
        const runtime = this.runtimeManager.get(sessionId);
        if (runtime) {
          const state = await runtime.getState();
          return sendJson(res, 200, {
            sessionId,
            projectDirectory: null,
            runtimeCwd: state.cwd,
            model: state.model,
            running: true,
          });
        }
        const descriptor = await this.router.resolve({ type: "existing", sessionId });
        return sendJson(res, 200, descriptor);
      }

      if (req.method === "POST" && path === "/v1/sessions") {
        const body = (await readJson(req)) as JsonObject;
        const input = {
          projectDirectory:
            body.projectDirectory === undefined ? null : (body.projectDirectory as string | null),
          model: body.model as { provider: string; modelId: string; presetId?: string } | undefined,
          originChannel: (body.originChannel as "web" | "wechat" | undefined) ?? "web",
        };
        const descriptor = await this.router.resolve({ type: "new", input });
        return sendJson(res, 201, descriptor);
      }

      if (req.method === "POST" && commandMatch) {
        const sessionId = commandMatch[1];
        const body = (await readJson(req)) as JsonObject;
        // Runtime 未激活时才尝试恢复已有 Session（新建未落盘 Session 直接使用活动 Runtime）
        if (!this.runtimeManager.get(sessionId)) {
          await this.router.resolve({ type: "existing", sessionId });
        }
        const result = await this.runtimeManager.sendCommand(sessionId, body as SessionCommand);
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && eventMatch) {
        const sessionId = eventMatch[1];
        // Runtime 未激活时先恢复（与 commands 端点一致）：前端协议是先连事件流再发命令，
        // 若不恢复则历史 Session 的 SSE 会 409 → 前端误报 "Failed to connect to Personal Gateway"
        if (!this.runtimeManager.get(sessionId)) {
          await this.router.resolve({ type: "existing", sessionId });
        }
        return this.streamEvents(req, res, sessionId);
      }

      if (req.method === "GET" && path === "/v1/channels/wechat/config") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, this.wechatController.getConfig());
      }

      if (req.method === "PUT" && path === "/v1/channels/wechat/config") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        const body = (await readJson(req)) as JsonObject;
        return sendJson(res, 200, this.wechatController.setConfig(body as never));
      }

      if (req.method === "GET" && path === "/v1/channels/wechat") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, await this.wechatController.status());
      }

      if (req.method === "POST" && path === "/v1/channels/wechat/disconnect") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, await this.wechatController.disconnect());
      }

      if (req.method === "POST" && path === "/v1/channels/wechat/reconnect") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, await this.wechatController.reconnect());
      }

      if (path === "/v1/channels/wechat/connect") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (req.method === "POST") {
          const body = (await readJson(req)) as JsonObject;
          return sendJson(res, 200, await this.wechatController.connectStart(Boolean(body.force)));
        }
        if (req.method === "GET") {
          const sessionId = url.searchParams.get("session_id") ?? "";
          const verifyCode = url.searchParams.get("verify_code") ?? "";
          return sendJson(res, 200, await this.wechatController.connectPoll(sessionId, verifyCode));
        }
      }

      if (req.method === "POST" && path === "/v1/channels/wechat/connect/cancel") {
        if (!this.wechatController) return sendJson(res, 404, { error: "not_found" });
        const body = (await readJson(req)) as JsonObject;
        return sendJson(res, 200, await this.wechatController.connectCancel(String(body.session_id ?? "")));
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("session not found")) {
        return sendJson(res, 404, { error: "session_not_found" });
      }
      if (message.startsWith("directory does not exist")) {
        return sendJson(res, 400, { error: "invalid_project_directory", message });
      }
      if (message.startsWith("unsupported command")) {
        return sendJson(res, 400, { error: "invalid_command", message });
      }
      sendJson(res, 500, {
        error: "internal_error",
        message,
      });
    }
  };

  /** SSE Event 流：初始快照 + 订阅转发；断线只退订，不终止 Runtime */
  private streamEvents(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    const runtime = this.runtimeManager.get(sessionId);
    if (!runtime) {
      return sendJson(res, 409, { error: "runtime_not_active", sessionId });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    // 初始快照，让重新订阅的客户端能拿到当前状态（envelope 格式，与 C-3 一致）
    void runtime
      .getState()
      .then((state) => {
        const envelope: GatewayEvent = {
          sessionId,
          sequence: 0,
          type: "state",
          timestamp: Date.now(),
          payload: state,
        };
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      })
      .catch((err) =>
        console.error(`[gateway] sse state snapshot failed: ${sessionId}`, err),
      );
    const unsubscribe = runtime.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", () => {
      unsubscribe();
      res.end();
    });
  }
}

export function createGatewayServer(
  router: SessionRouter,
  runtimeManager: RuntimeManager,
  wechatController?: WechatChannelController,
): Server {
  const gateway = new Gateway(router, runtimeManager, wechatController);
  return createServer((req, res) => {
    void gateway.handler(req, res);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as JsonObject) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
