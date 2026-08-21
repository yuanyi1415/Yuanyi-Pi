/**
 * SessionRouter（DEV214）
 *
 * 创建 / 定位统一 Session，把 Web / 微信请求路由到统一 Session：
 * - resolveNew：无项目 projectDirectory=null → 独立 workspace；有项目 → projectDirectory
 * - resolveExisting：sessionId → 从 Pi Session 定位 sessionFile → resume
 * - list：Pi Persisted Sessions + Personal Metadata + Active Runtime 合并
 *
 * Pi Session 是第一真实性判断；Metadata 存在但 Pi Session 不存在时标记 orphan，
 * 不生成虚假 Session（架构设计 R-005）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeManager } from "../runtime/manager";
import type { MetadataStore, SessionMeta } from "../metadata/store";
import type { KnownProject, ModelSelection, SessionDescriptor } from "../contracts";

export interface NewSessionInput {
  /** 用户语义：真实本地目录；null/缺省 = 无项目 */
  projectDirectory?: string | null;
  projectDisplayName?: string | null;
  model?: ModelSelection;
  originChannel?: "web" | "wechat";
}

export interface SessionProjectionOptions {
  leafId?: string;
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
}

export type SessionTarget =
  | { type: "existing"; sessionId: string }
  | { type: "new"; input: NewSessionInput };

export interface SessionRouterOptions {
  runtimeManager: RuntimeManager;
  metadata: MetadataStore;
  /** 无项目安全默认运行目录（不展示为项目） */
  neutralCwd: string;
  /** 无项目 Session 的独立工作区根目录 */
  workspaceRoot?: string;
  /** Pi session 根目录；缺省用 Pi 默认（基于 agentDir）。测试可指定临时目录隔离 */
  sessionDir?: string;
}

export class SessionRouter {
  private readonly sessionPathCache = new Map<string, string>();
  private readonly pending = new Map<string, {
    projectDirectory: string | null;
    projectDisplayName: string | null;
    hadProject: boolean;
  }>();

  constructor(private readonly opts: SessionRouterOptions) {}

  async resolve(target: SessionTarget): Promise<SessionDescriptor> {
    return target.type === "new"
      ? this.resolveNew(target.input)
      : this.resolveExisting(target.sessionId);
  }

  async resolveNew(input: NewSessionInput): Promise<SessionDescriptor> {
    const projectDirectory = input.projectDirectory ? canonicalProjectDirectory(input.projectDirectory) : null;
    const runtime = await this.opts.runtimeManager.getOrCreate({
      cwd: projectDirectory ?? this.opts.neutralCwd,
      ...(projectDirectory == null && this.opts.workspaceRoot
        ? { workspaceRoot: this.opts.workspaceRoot }
        : {}),
      model: input.model,
    });
    const meta: SessionMeta = {
      projectDirectory,
      originChannel: input.originChannel ?? "web",
    };
    this.opts.metadata.setSessionMeta(runtime.sessionId, meta);
    if (projectDirectory) {
      this.opts.metadata.upsertProject(projectDirectory, input.projectDisplayName?.trim() || basename(projectDirectory));
    }
    return this.describe(runtime.sessionId);
  }

  /** 只启动内存 Runtime；项目/Session 元数据在首条 prompt 前不落盘。 */
  async prepareNew(input: NewSessionInput): Promise<SessionDescriptor> {
    const projectDirectory = input.projectDirectory ? canonicalProjectDirectory(input.projectDirectory) : null;
    const runtime = await this.opts.runtimeManager.getOrCreate({
      cwd: projectDirectory ?? this.opts.neutralCwd,
      ...(projectDirectory == null && this.opts.workspaceRoot
        ? { workspaceRoot: this.opts.workspaceRoot }
        : {}),
      model: input.model,
    });
    this.pending.set(runtime.sessionId, {
      projectDirectory,
      projectDisplayName: input.projectDisplayName?.trim() || null,
      hadProject: projectDirectory ? Boolean(this.opts.metadata.getProject(projectDirectory)) : true,
    });
    const descriptor = await this.describe(runtime.sessionId);
    return {
      ...descriptor,
      projectDirectory,
      projectDisplayName: projectDirectory
        ? (input.projectDisplayName?.trim() || this.opts.metadata.getProject(projectDirectory)?.displayName || basename(projectDirectory))
        : undefined,
      runtimeCwd: (await runtime.getState()).cwd,
    };
  }

  commitPrepared(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.opts.metadata.setSessionMeta(sessionId, {
      projectDirectory: pending.projectDirectory,
      originChannel: "web",
    });
    if (pending.projectDirectory) {
      this.opts.metadata.upsertProject(
        pending.projectDirectory,
        pending.projectDisplayName || basename(pending.projectDirectory),
      );
    }
  }

  finalizePrepared(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  async rollbackPrepared(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    const sessionFile = await this.findSessionFile(sessionId);
    await this.opts.runtimeManager.dispose(sessionId);
    if (sessionFile) {
      unlinkSync(sessionFile);
      this.sessionPathCache.delete(sessionId);
    }
    this.opts.metadata.removeSessionMeta(sessionId);
    if (pending.projectDirectory && !pending.hadProject) {
      this.opts.metadata.removeProject(pending.projectDirectory);
    }
    this.pending.delete(sessionId);
  }

  async listProjects(): Promise<KnownProject[]> {
    const projects = new Map(this.opts.metadata.getProjects().map((project) => [project.path, project]));
    for (const meta of Object.values(this.opts.metadata.getSessionMetaAll())) {
      if (!meta.projectDirectory || projects.has(meta.projectDirectory)) continue;
      const project = this.opts.metadata.upsertProject(meta.projectDirectory, basename(meta.projectDirectory));
      projects.set(project.path, project);
    }
    return [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async renameProject(projectDirectory: string, displayName: string): Promise<KnownProject> {
    const path = canonicalProjectDirectory(projectDirectory);
    const project = this.opts.metadata.renameProject(path, displayName);
    if (!project) throw new Error(`project not found: ${path}`);
    return project;
  }

  /**
   * 删除 Project（S6-02 冻结语义）：只有没有任何 Session 引用的 Project 才允许删除。
   * 有 Session 引用 → throw（Gateway 映射 409 project_in_use）；不存在 → throw（404）。
   * 路径匹配同时尝试 canonical（realpath）与原值，兼容创建时 canonical 化后的存储。
   */
  removeProject(projectDirectory: string): void {
    const candidates = [projectDirectory];
    try {
      candidates.unshift(realpathSync(projectDirectory));
    } catch {
      // 目录已不存在：仅用原路径匹配
    }
    const hit = [...new Set(candidates)];
    for (const meta of Object.values(this.opts.metadata.getSessionMetaAll())) {
      if (meta.projectDirectory && hit.includes(meta.projectDirectory)) {
        throw new Error(`project in use: ${meta.projectDirectory}`);
      }
    }
    const removed = hit.some((path) => this.opts.metadata.removeProject(path));
    if (!removed) throw new Error(`project not found: ${projectDirectory}`);
  }

  async resolveExisting(sessionId: string): Promise<SessionDescriptor> {
    if (this.opts.runtimeManager.get(sessionId)) return this.describe(sessionId);
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) {
      throw new Error(`session not found: ${sessionId}`);
    }
    await this.opts.runtimeManager.getOrCreate({ sessionFile, cwd: "" });
    return this.describe(sessionId);
  }

  async getContext(
    sessionId: string,
    options: SessionProjectionOptions = {},
  ): Promise<unknown> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) throw new Error(`session not found: ${sessionId}`);
    const session = SessionManager.open(sessionFile);
    const entries = session.getEntries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const selected = buildContextEntries(entries, options.leafId, byId);
    const messages = selected.flatMap((entry) => sessionEntryToContextMessages(entry)
      .map((message) => projectContextMessage(message, options)));
    return {
      ...buildSessionContext(entries, options.leafId, byId),
      messages,
      entryIds: selected.flatMap((entry) => sessionEntryToContextMessages(entry).length > 0
        ? sessionEntryToContextMessages(entry).map(() => entry.id)
        : []),
    };
  }

  async getDocument(sessionId: string, options: SessionProjectionOptions = {}): Promise<unknown> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) throw new Error(`session not found: ${sessionId}`);
    const session = SessionManager.open(sessionFile);
    const entries = session.getEntries();
    const context = await this.getContext(sessionId, options);
    const firstMessage = (context as { messages?: Array<{ role?: string; content?: unknown }> }).messages
      ?.find((message) => message.role === "user");
    const firstMessageText = typeof firstMessage?.content === "string"
      ? firstMessage.content
      : "(no messages)";
    const header = session.getHeader();
    const modified = statSync(sessionFile).mtime.toISOString();
    return {
      filePath: sessionFile,
      info: {
        path: sessionFile,
        id: session.getSessionId(),
        cwd: session.getCwd(),
        name: session.getSessionName(),
        created: header?.timestamp,
        modified,
        messageCount: (context as { messages?: unknown[] }).messages?.length ?? 0,
        firstMessage: firstMessageText,
        transient: false,
      },
      leafId: options.leafId ?? session.getLeafId(),
      tree: session.getTree(),
      totalActiveMs: computeSessionTotalActiveMs(entries),
      context,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) throw new Error(`session not found: ${sessionId}`);

    const header = readSessionHeader(sessionFile);
    const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined;
    const target = sessionFile;
    for (const name of readdirSync(dirname(target))) {
      if (!name.endsWith(".jsonl")) continue;
      const childPath = join(dirname(target), name);
      if (childPath === target) continue;
      try {
        const lines = readFileSync(childPath, "utf8").split("\n");
        const childHeader = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (childHeader.type === "session" && childHeader.parentSession === target) {
          childHeader.parentSession = parentSession;
          lines[0] = JSON.stringify(childHeader);
          writeFileSync(childPath, lines.join("\n"), "utf8");
        }
      } catch {
        // Ignore malformed sibling files; deleting the requested session remains valid.
      }
    }

    await this.opts.runtimeManager.dispose(sessionId);
    unlinkSync(sessionFile);
    this.sessionPathCache.delete(sessionId);
    this.opts.metadata.removeSessionMeta(sessionId);
    this.opts.metadata.removeBindingsForSession(sessionId);
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
      if (this.pending.has(sessionId)) continue;
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const meta = this.opts.metadata.getSessionMeta(sessionId);
      const running = this.opts.runtimeManager.isRunning(sessionId);
      const runtime = this.opts.runtimeManager.get(sessionId);
      descriptors.push({
        sessionId,
        title: info.name,
        projectDirectory: meta?.projectDirectory ?? null,
        projectDisplayName: meta?.projectDirectory
          ? this.opts.metadata.getProject(meta.projectDirectory)?.displayName
          : undefined,
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
      projectDisplayName: meta?.projectDirectory
        ? this.opts.metadata.getProject(meta.projectDirectory)?.displayName
        : undefined,
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

function canonicalProjectDirectory(directory: string): string {
  if (!existsSync(directory)) throw new Error(`directory does not exist: ${directory}`);
  try {
    const canonical = realpathSync(directory);
    if (!statSync(canonical).isDirectory()) throw new Error(`directory does not exist: ${directory}`);
    return canonical;
  } catch {
    throw new Error(`directory does not exist: ${directory}`);
  }
}

function computeSessionTotalActiveMs(entries: ReadonlyArray<{
  type?: string;
  timestamp?: string;
  message?: { role?: string };
}>): number {
  let totalActiveMs = 0;
  let previousTimestamp: number | undefined;
  for (const entry of entries) {
    if (!entry.type || !entry.timestamp || !isTimingEntry(entry.type)) continue;
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "bashExecution")) {
      previousTimestamp = timestamp;
      continue;
    }
    if (previousTimestamp !== undefined && timestamp > previousTimestamp) {
      totalActiveMs += timestamp - previousTimestamp;
    }
    previousTimestamp = timestamp;
  }
  return totalActiveMs;
}

function isTimingEntry(type: string): boolean {
  return type === "message"
    || type === "compaction"
    || type === "branch_summary"
    || type === "custom_message";
}

function projectContextMessage(
  message: { role?: string; content?: unknown },
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): typeof message {
  if (!Array.isArray(message.content)) return message;
  let content = message.content as Array<Record<string, unknown>>;
  if (options.deferToolResultImages && message.role === "toolResult") {
    let omitted = 0;
    let bytes = 0;
    const mimes = new Set<string>();
    content = content.filter((block) => {
      if (block.type !== "image") return true;
      const data = typeof block.data === "string"
        ? block.data
        : typeof (block.source as { data?: unknown } | undefined)?.data === "string"
          ? (block.source as { data: string }).data
          : undefined;
      if (!data) return true;
      omitted += 1;
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      bytes += Math.max(0, Math.floor(data.length * 3 / 4) - padding);
      const mime = typeof block.mimeType === "string"
        ? block.mimeType
        : typeof (block.source as { media_type?: unknown } | undefined)?.media_type === "string"
          ? (block.source as { media_type: string }).media_type
          : undefined;
      if (mime) mimes.add(mime);
      return false;
    });
    if (omitted > 0) {
      const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
      content = [...content, {
        type: "text",
        text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
      }];
    }
  }
  if (options.deferThinking && message.role === "assistant") {
    content = content.map((block) => (
      block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== ""
        ? { ...block, thinking: "", deferred: true }
        : block
    ));
  }
  return { ...message, content };
}

function readSessionHeader(sessionFile: string): { parentSession?: string } | undefined {
  try {
    return JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]) as { parentSession?: string };
  } catch {
    return undefined;
  }
}
