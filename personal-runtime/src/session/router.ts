/**
 * SessionRouter（DEV214）
 *
 * 创建 / 定位统一 Session，把 Web / 微信请求路由到统一 Session：
 * - resolveNew：无项目 projectDirectory=null → neutralCwd；有项目 → projectDirectory
 * - resolveExisting：sessionId → 从 Pi Session 定位 sessionFile → resume
 * - list：Pi Persisted Sessions + Personal Metadata + Active Runtime 合并
 *
 * Pi Session 是第一真实性判断；Metadata 存在但 Pi Session 不存在时标记 orphan，
 * 不生成虚假 Session（架构设计 R-005）。
 */
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeManager } from "../runtime/manager";
import type { MetadataStore, SessionMeta } from "../metadata/store";
import type { ModelSelection, SessionDescriptor } from "../contracts";

export interface NewSessionInput {
  /** 用户语义：真实本地目录；null/缺省 = 无项目 */
  projectDirectory?: string | null;
  model?: ModelSelection;
  originChannel?: "web" | "wechat";
}

export type SessionTarget =
  | { type: "existing"; sessionId: string }
  | { type: "new"; input: NewSessionInput };

export interface SessionRouterOptions {
  runtimeManager: RuntimeManager;
  metadata: MetadataStore;
  /** 无项目安全默认运行目录（不展示为项目） */
  neutralCwd: string;
  /** Pi session 根目录；缺省用 Pi 默认（基于 agentDir）。测试可指定临时目录隔离 */
  sessionDir?: string;
}

export class SessionRouter {
  private readonly sessionPathCache = new Map<string, string>();

  constructor(private readonly opts: SessionRouterOptions) {}

  async resolve(target: SessionTarget): Promise<SessionDescriptor> {
    return target.type === "new"
      ? this.resolveNew(target.input)
      : this.resolveExisting(target.sessionId);
  }

  async resolveNew(input: NewSessionInput): Promise<SessionDescriptor> {
    // 项目目录必须真实存在（技术设计 5.1：cwd 不存在 → 结构化错误）
    if (input.projectDirectory && !existsSync(input.projectDirectory)) {
      throw new Error(`directory does not exist: ${input.projectDirectory}`);
    }
    const runtimeCwd = input.projectDirectory ?? this.opts.neutralCwd;
    const runtime = await this.opts.runtimeManager.getOrCreate({
      cwd: runtimeCwd,
      model: input.model,
    });
    const meta: SessionMeta = {
      projectDirectory: input.projectDirectory ?? null,
      originChannel: input.originChannel ?? "web",
    };
    this.opts.metadata.setSessionMeta(runtime.sessionId, meta);
    return this.describe(runtime.sessionId);
  }

  async resolveExisting(sessionId: string): Promise<SessionDescriptor> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) {
      throw new Error(`session not found: ${sessionId}`);
    }
    await this.opts.runtimeManager.getOrCreate({ sessionFile, cwd: "" });
    return this.describe(sessionId);
  }

  /** 合并 Pi Persisted + Personal Metadata + Active Runtime */
  async list(): Promise<SessionDescriptor[]> {
    const infos = await this.listAllSessions();
    for (const info of infos) {
      this.sessionPathCache.set(info.id, info.path);
    }
    const descriptors: SessionDescriptor[] = [];
    const seen = new Set<string>();
    for (const info of infos) {
      const sessionId = info.id;
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const meta = this.opts.metadata.getSessionMeta(sessionId);
      const running = this.opts.runtimeManager.isRunning(sessionId);
      const runtime = this.opts.runtimeManager.get(sessionId);
      descriptors.push({
        sessionId,
        title: info.name,
        projectDirectory: meta?.projectDirectory ?? null,
        runtimeCwd: info.cwd || (runtime ? (await runtime.getState()).cwd : ""),
        originChannel: meta?.originChannel,
        model: runtime ? (await runtime.getState()).model : undefined,
        running,
        createdAt: info.created.getTime(),
        updatedAt: info.modified.getTime(),
      });
    }
    // orphan 标记：metadata 存在但 Pi Session 不存在
    for (const sessionId of Object.keys(this.opts.metadata.getSessionMetaAll())) {
      if (!seen.has(sessionId)) {
        descriptors.push({
          sessionId,
          projectDirectory: null,
          runtimeCwd: "",
          running: false,
        });
      }
    }
    return descriptors;
  }

  private async describe(sessionId: string): Promise<SessionDescriptor> {
    const runtime = this.opts.runtimeManager.get(sessionId);
    const state = runtime ? await runtime.getState() : undefined;
    const meta = this.opts.metadata.getSessionMeta(sessionId);
    return {
      sessionId,
      projectDirectory: meta?.projectDirectory ?? null,
      runtimeCwd: state?.cwd ?? "",
      originChannel: meta?.originChannel,
      model: state?.model,
      running: this.opts.runtimeManager.isRunning(sessionId),
    };
  }

  /** sessionId → Pi sessionFile（进程内缓存 + listAll 扫描兜底） */
  private async findSessionFile(sessionId: string): Promise<string | undefined> {
    const cached = this.sessionPathCache.get(sessionId);
    if (cached) return cached;
    const infos = await this.listAllSessions();
    for (const info of infos) {
      this.sessionPathCache.set(info.id, info.path);
    }
    return this.sessionPathCache.get(sessionId);
  }

  private async listAllSessions() {
    const infos = this.opts.sessionDir
      ? await SessionManager.listAll(this.opts.sessionDir)
      : await SessionManager.listAll();
    for (const info of infos) {
      this.sessionPathCache.set(info.id, info.path);
    }
    return infos;
  }
}
