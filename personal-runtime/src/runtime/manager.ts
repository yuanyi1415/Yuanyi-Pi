/**
 * RuntimeManager（DEV213）
 *
 * sessionId -> active AgentSession 的唯一持有者：
 * - Registry：sessionId（Pi 生成，统一主身份 AD-003）→ RuntimeEntry
 * - 启动锁：同一 sessionFile 并发 resume 只产生一个 Runtime
 * - Prompt 串行：同一 Session 普通 Prompt 排队执行
 * - 空闲回收：只释放内存 Runtime，不删除持久 Session；进程重启后按需恢复
 *
 * sessionId 一律以 Pi 生成为准：resume 从 sessionFile 头部读取，create 每次新建。
 * 不解析 sessionId → sessionFile（那是 Session Router / Metadata 职责，DEV214）。
 */
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeAdapter } from "../pi/adapter";
import type {
  ModelSelection,
  PromptAck,
  SessionCommand,
  SessionRuntimeState,
} from "../contracts";

export interface RuntimeStartOptions {
  /** resume 时提供：已持久化 Pi Session 的文件路径（必须存在） */
  sessionFile?: string;
  /** create 时提供：运行目录（无项目=neutralCwd，有项目=projectDirectory） */
  cwd: string;
  /** 可选：覆盖初始模型 */
  model?: ModelSelection;
  /** Pi 数据目录（默认 getAgentDir()） */
  agentDir?: string;
}

export interface RuntimeEntry {
  sessionId: string;
  runtime: PiRuntimeAdapter;
  lastActiveAt: number;
  state: "starting" | "ready" | "busy" | "disposing" | "error";
}

/** 默认空闲回收阈值：与 Pi Web 现有约 10 分钟一致 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 回收扫描间隔 */
const SCAN_INTERVAL_MS = 30 * 1000;

export class RuntimeManager {
  private readonly registry = new Map<string, RuntimeEntry>();
  private readonly inflight = new Map<string, Promise<PiRuntimeAdapter>>();
  private readonly promptTails = new Map<string, Promise<unknown>>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      agentDir?: string;
      idleTimeoutMs?: number;
      /** 回收扫描间隔（默认 30s；测试可缩短） */
      scanIntervalMs?: number;
    } = {},
  ) {
    this.scanTimer = setInterval(
      () => void this.scanIdle(),
      this.opts.scanIntervalMs ?? SCAN_INTERVAL_MS,
    );
    this.scanTimer.unref();
  }

  /** 获取已存在的 Runtime（不创建） */
  get(sessionId: string): PiRuntimeAdapter | undefined {
    return this.registry.get(sessionId)?.runtime;
  }

  /**
   * 启动或复用 Runtime：
   * - sessionFile 提供 → resume（从文件头读 sessionId，并发启动锁）
   * - 否则 → create 新 Session（Pi 生成新 sessionId）
   */
  getOrCreate(opts: RuntimeStartOptions): Promise<PiRuntimeAdapter> {
    if (opts.sessionFile) {
      const sessionId = readSessionIdFromFile(opts.sessionFile);
      const existing = this.registry.get(sessionId);
      if (existing && existing.state !== "disposing" && existing.state !== "error") {
        return Promise.resolve(existing.runtime);
      }
      const inflight = this.inflight.get(sessionId);
      if (inflight) return inflight;

      const starting = this.start(opts, sessionId).finally(() =>
        this.inflight.delete(sessionId),
      );
      this.inflight.set(sessionId, starting);
      return starting;
    }
    // create：每次新 id，无需锁
    return this.start(opts, undefined);
  }

  private async start(opts: RuntimeStartOptions, sessionId: string | undefined) {
    const { PiRuntimeAdapter } = await import("../pi/adapter");
    // 构造的 agentDir 必须传递：getOrCreate 未显式传时，不能落回 SDK 默认（生产 ~/.pi/agent）
    const agentDir = opts.agentDir ?? this.opts.agentDir;
    const { model, cwd } = opts;
    const runtime = sessionId
      ? await PiRuntimeAdapter.resume({ sessionFile: opts.sessionFile!, agentDir, model })
      : await PiRuntimeAdapter.create({ cwd, agentDir, model });

    this.registry.set(runtime.sessionId, {
      sessionId: runtime.sessionId,
      runtime,
      lastActiveAt: Date.now(),
      state: "ready",
    });
    return runtime;
  }

  /** 普通 Prompt（同一 Session 串行排队） */
  async prompt(sessionId: string, message: string): Promise<PromptAck> {
    const runtime = this.require(sessionId);
    const tail = this.promptTails.get(sessionId) ?? Promise.resolve();
    const run = tail.then(() => {
      this.touch(sessionId);
      return runtime.prompt(message);
    });
    this.promptTails.set(sessionId, run.catch(() => undefined));
    return run;
  }

  /** 执行命令面（steer/follow_up 等由 Pi 原生语义处理，不排队） */
  async sendCommand(sessionId: string, command: SessionCommand): Promise<unknown> {
    const runtime = this.require(sessionId);
    this.touch(sessionId);
    return runtime.sendCommand(command);
  }

  async getState(sessionId: string): Promise<SessionRuntimeState> {
    const runtime = this.require(sessionId);
    return runtime.getState();
  }

  /** 更新活动时间（防止被空闲回收） */
  touch(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (entry) entry.lastActiveAt = Date.now();
  }

  isRunning(sessionId: string): boolean {
    const entry = this.registry.get(sessionId);
    return entry !== undefined && entry.state !== "disposing" && entry.state !== "error";
  }

  /** 当前活动 Runtime 列表（DEV222 list sessions 用） */
  getActiveSessionIds(): string[] {
    return [...this.registry.values()]
      .filter((e) => e.state !== "disposing" && e.state !== "error")
      .map((e) => e.sessionId);
  }

  /** 主动释放某个 Runtime（不删除持久 Session） */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    entry.state = "disposing";
    await entry.runtime.dispose();
    this.registry.delete(sessionId);
  }

  /** 全部释放（进程 shutdown） */
  async shutdown(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    await Promise.all([...this.registry.keys()].map((id) => this.dispose(id)));
  }

  private require(sessionId: string): PiRuntimeAdapter {
    const runtime = this.get(sessionId);
    if (!runtime) throw new Error(`runtime not active: ${sessionId}`);
    return runtime;
  }

  /** 空闲回收：只释放内存 Runtime，不删除持久 Session */
  private async scanIdle(): Promise<void> {
    const idleTimeoutMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const now = Date.now();
    const idle: string[] = [];
    for (const [sessionId, entry] of this.registry) {
      if (entry.state === "busy" || entry.state === "starting") continue;
      if (now - entry.lastActiveAt >= idleTimeoutMs) idle.push(sessionId);
    }
    for (const sessionId of idle) {
      await this.dispose(sessionId);
    }
  }
}

/** 从已持久化 Session 文件读取 Pi Session ID（文件必须存在） */
function readSessionIdFromFile(sessionFile: string): string {
  if (!existsSync(sessionFile)) {
    throw new Error(`session file not found: ${sessionFile}`);
  }
  const sm = SessionManager.open(sessionFile, undefined);
  return sm.getSessionId();
}
