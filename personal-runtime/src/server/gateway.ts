/**
 * Personal Gateway（DEV222 / DEV223 / DEV224）
 *
 * 一期统一三类接口（技术设计 3.1）：
 * - Session Query：GET /v1/sessions、GET /v1/sessions/{id}、POST /v1/sessions
 * - Project Query：GET /v1/projects、PATCH/DELETE /v1/projects
 * - Session Command：POST /v1/sessions/{id}/commands
 * - Session Event：GET /v1/sessions/{id}/events（SSE）
 *
 * 零框架：Node 原生 http。SSE 断线不终止 Runtime（技术设计 5.3）。
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { SessionRouter } from "../session/router";
import type { RuntimeManager } from "../runtime/manager";
import type { SessionCommand, GatewayEvent, PromptAck } from "../contracts";
import type { WechatChannelController } from "../channel/wechat/controller";

type JsonObject = Record<string, unknown>;

export class Gateway {
  constructor(
    private readonly router: SessionRouter,
    private readonly runtimeManager: RuntimeManager,
    private readonly wechatController?: WechatChannelController,
    private readonly agentDir = "",
  ) {}

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (path === "/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, service: "personal-runtime" });
      }

      if (path === "/v1/project-trust" && req.method === "GET") {
        return sendJson(res, 200, this.projectTrustStatus(url.searchParams.get("cwd") ?? ""));
      }

      if (path === "/v1/project-trust" && req.method === "POST") {
        const body = (await readJson(req)) as JsonObject;
        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        const result = await this.runtimeManager.withProjectTrust(cwd, async () => {
          const status = this.projectTrustStatus(cwd);
          if (!status.requiresTrust) {
            return {
              status: 409,
              body: { error: "This project has no resources that require trust" },
            };
          }
          if (await this.runtimeManager.hasBusySessionForCwd(cwd)) {
            return {
              status: 409,
              body: { error: "Wait for the active session to finish before trusting the project" },
            };
          }
          new ProjectTrustStore(this.agentDir).set(cwd, true);
          await this.runtimeManager.disposeSessionsForCwd(cwd);
          return { status: 200, body: { requiresTrust: true, trusted: true } };
        });
        return sendJson(res, result.status, result.body);
      }

      if (req.method === "GET" && path === "/v1/sessions") {
        const list = await this.router.list();
        return sendJson(res, 200, { sessions: list });
      }

      if (req.method === "GET" && path === "/v1/projects") {
        return sendJson(res, 200, { projects: await this.router.listProjects() });
      }

      if (req.method === "PATCH" && path === "/v1/projects") {
        const body = (await readJson(req)) as JsonObject;
        const projectDirectory = typeof body.projectDirectory === "string" ? body.projectDirectory : "";
        const displayName = typeof body.displayName === "string" ? body.displayName : "";
        return sendJson(res, 200, await this.router.renameProject(projectDirectory, displayName));
      }

      if (req.method === "DELETE" && path === "/v1/projects") {
        const body = (await readJson(req)) as JsonObject;
        const projectDirectory = typeof body.projectDirectory === "string" ? body.projectDirectory : "";
        if (!projectDirectory) return sendJson(res, 400, { error: "projectDirectory is required" });
        try {
          this.router.removeProject(projectDirectory);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith("project in use")) {
            return sendJson(res, 409, { error: "project_in_use", message });
          }
          if (message.startsWith("project not found")) {
            return sendJson(res, 404, { error: "project_not_found", message });
          }
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
      const contextMatch = path.match(/^\/v1\/sessions\/([^/]+)\/context$/);
      const documentMatch = path.match(/^\/v1\/sessions\/([^/]+)\/document$/);
      const commandMatch = path.match(/^\/v1\/sessions\/([^/]+)\/commands$/);
      const eventMatch = path.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      const titleMatch = path.match(/^\/v1\/sessions\/([^/]+)\/title\/generate$/);
      if (req.method === "GET" && contextMatch) {
        return sendJson(res, 200, {
          context: await this.router.getContext(contextMatch[1], {
            leafId: url.searchParams.get("leafId") ?? undefined,
            deferThinking: url.searchParams.has("deferThinking"),
            deferToolResultImages: url.searchParams.has("deferMedia"),
          }),
        });
      }
      if (req.method === "GET" && documentMatch) {
        return sendJson(res, 200, await this.router.getDocument(documentMatch[1], {
          leafId: url.searchParams.get("leafId") ?? undefined,
          deferThinking: url.searchParams.has("deferThinking"),
          deferToolResultImages: url.searchParams.has("deferMedia"),
        }));
      }
      if (req.method === "POST" && titleMatch) {
        const sessionId = titleMatch[1];
        if (!this.runtimeManager.get(sessionId)) {
          await this.router.resolve({ type: "existing", sessionId });
        }
        const result = await this.runtimeManager.generateSessionTitle(sessionId);
        await this.runtimeManager.sendCommand(sessionId, { type: "set_session_name", name: result.title });
        return sendJson(res, 200, result);
      }
      if (req.method === "DELETE" && sessionMatch) {
        await this.router.deleteSession(sessionMatch[1]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && sessionMatch) {
        const sessionId = sessionMatch[1];
        const descriptor = await this.router.resolve({ type: "existing", sessionId });
        return sendJson(res, 200, descriptor);
      }

      if (req.method === "POST" && path === "/v1/sessions") {
        const body = (await readJson(req)) as JsonObject;
        const input = {
          projectDirectory:
            body.projectDirectory === undefined ? null : (body.projectDirectory as string | null),
          projectDisplayName: typeof body.projectDisplayName === "string" ? body.projectDisplayName : null,
          model: body.model as { provider: string; modelId: string; presetId?: string } | undefined,
          originChannel: (body.originChannel as "web" | "wechat" | undefined) ?? "web",
        };
        const descriptor = await this.router.resolve({ type: "new", input });
        return sendJson(res, 201, descriptor);
      }

      if (req.method === "POST" && path === "/v1/sessions/prepare") {
        const body = (await readJson(req)) as JsonObject;
        const descriptor = await this.router.prepareNew({
          projectDirectory: body.projectDirectory === undefined ? null : (body.projectDirectory as string | null),
          projectDisplayName: typeof body.projectDisplayName === "string" ? body.projectDisplayName : null,
          model: body.model as { provider: string; modelId: string; presetId?: string } | undefined,
          originChannel: "web",
        });
        return sendJson(res, 201, descriptor);
      }

      if (req.method === "POST" && commandMatch) {
        const sessionId = commandMatch[1];
        const body = (await readJson(req)) as JsonObject;
        if (body.type === "prompt") {
          console.info("[perf]", JSON.stringify({
            phase: "T1",
            requestId: req.headers["x-yuanyi-request-id"] ?? null,
            t0: req.headers["x-yuanyi-t0"] ?? null,
            sessionId,
            at: Date.now(),
          }));
        }
        // Runtime 未激活时才尝试恢复已有 Session（新建未落盘 Session 直接使用活动 Runtime）
        if (!this.runtimeManager.get(sessionId)) {
          await this.router.resolve({ type: "existing", sessionId });
        }
        const isPreparedPrompt = body.type === "prompt";
        try {
          const result = await this.runtimeManager.sendCommand(sessionId, body as SessionCommand, {
            requestId: typeof req.headers["x-yuanyi-request-id"] === "string"
              ? req.headers["x-yuanyi-request-id"]
              : undefined,
            // S6-01（IssueLog-006）：Commit Point = Pi 原生 preflightResult(true) 时刻，
            // 而不是整轮 Agent 执行结束。preflight 回调为同步信号，Pi 在回调返回后才进入 Agent Loop，
            // 因此这里同步 commit/finalize（均为同步写盘）可保证 Agent 正式执行前 Session 已成立。
            ...(isPreparedPrompt
              ? {
                  onPromptPreflight: (accepted: boolean) => {
                    if (accepted) {
                      this.router.commitPrepared(sessionId);
                      this.router.finalizePrepared(sessionId);
                    }
                  },
                }
              : {}),
          });
          if (isPreparedPrompt) {
            const ack = result as PromptAck;
            if (ack?.accepted) {
              // 兜底：preflight 回调通常已在 accepted 时完成 commit/finalize；此处幂等（pending 已清则 no-op）
              this.router.commitPrepared(sessionId);
              this.router.finalizePrepared(sessionId);
            } else {
              await this.router.rollbackPrepared(sessionId);
              return sendJson(res, 200, result);
            }
          }
          return sendJson(res, 200, result);
        } catch (error) {
          // 已被 Pi 接受的 prompt（仅执行期失败）不回滚；仅 preflight 失败路径回滚。
          if (isPreparedPrompt && !isPromptAcceptedError(error)) {
            await this.router.rollbackPrepared(sessionId);
          }
          throw error;
        }
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

  private projectTrustStatus(cwd: string): { requiresTrust: boolean; trusted: boolean } {
    if (!cwd || !existsSync(cwd)) return { requiresTrust: false, trusted: true };
    const requiresTrust = hasTrustRequiringProjectResources(cwd);
    if (!requiresTrust) return { requiresTrust: false, trusted: true };
    return { requiresTrust: true, trusted: new ProjectTrustStore(this.agentDir).get(cwd) === true };
  }

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
    let closed = false;
    let snapshotSent = false;
    const pendingEvents: GatewayEvent[] = [];
    const writeEvent = (event: GatewayEvent) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const flushPendingEvents = () => {
      snapshotSent = true;
      for (const event of pendingEvents) writeEvent(event);
      pendingEvents.length = 0;
    };
    // 先订阅，避免 getState 等待期间丢事件；快照始终先于缓冲事件发出。
    const unsubscribe = runtime.subscribe((event) => {
      if (snapshotSent) writeEvent(event);
      else pendingEvents.push(event);
    });
    // 初始快照，让重新订阅的客户端能拿到当前状态（envelope 格式，与 C-3 一致）
    void runtime.getState()
      .then((state) => {
        const envelope: GatewayEvent = {
          sessionId,
          sequence: 0,
          type: "state",
          timestamp: Date.now(),
          payload: state,
        };
        writeEvent(envelope);
        flushPendingEvents();
      })
      .catch((err) => {
        console.error(`[gateway] sse state snapshot failed: ${sessionId}`, err);
        flushPendingEvents();
      });
    req.on("close", () => {
      closed = true;
      pendingEvents.length = 0;
      unsubscribe();
      res.end();
    });
  }
}

export function createGatewayServer(
  router: SessionRouter,
  runtimeManager: RuntimeManager,
  wechatController?: WechatChannelController,
  agentDir?: string,
): Server {
  const gateway = new Gateway(router, runtimeManager, wechatController, agentDir);
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

/** S6-01：已通过 Pi preflight 的 prompt 执行期错误不触发 prepared 回滚 */
function isPromptAcceptedError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { promptAccepted?: boolean }).promptAccepted === true;
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
