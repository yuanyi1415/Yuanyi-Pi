/**
 * PiRuntimeAdapter（DEV212）
 *
 * 封装 Pi AgentSession 创建/恢复、Prompt/Event/Abort、Model/Thinking/Tool。
 * 所有 Pi API 调用收敛于此（契约见 Stage-001 附录 C-2）。
 *
 * 实现策略：使用 SDK 高层 createAgentSession()（自动从 sessionFile 恢复已保存
 * model / thinking level），不复制 pi-web AgentSessionWrapper 全量逻辑；
 * 需要 extension binding / project trust 等深化时再迁移（DEV313 相关）。
 */
import { join } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  GatewayEvent,
  ModelSelection,
  PromptAck,
  SessionCommand,
  SessionRuntimeState,
  ThinkingLevel,
} from "../contracts";

export interface CreateRuntimeOptions {
  /** 运行目录（无项目=neutralCwd，有项目=projectDirectory） */
  cwd: string;
  /** Pi 数据目录，默认 getAgentDir()（~/.pi/agent 或 ~/.pi-dev/agent） */
  agentDir?: string;
  /** 初始模型选择；省略时由 SDK 按 settings / 已保存模型解析 */
  model?: ModelSelection;
}

export interface ResumeRuntimeOptions {
  sessionFile: string;
  agentDir?: string;
  model?: ModelSelection;
}

export class PiRuntimeAdapter {
  private sequence = 0;
  private disposed = false;
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly unsubscribeInner: () => void;
  private readonly modelRuntime: ModelRuntime;
  private readonly agentDir: string;

  private constructor(
    private readonly inner: AgentSession,
    modelRuntime: ModelRuntime,
    agentDir: string,
  ) {
    this.modelRuntime = modelRuntime;
    this.agentDir = agentDir;
    this.unsubscribeInner = inner.subscribe((event) => {
      const envelope: GatewayEvent = {
        sessionId: this.sessionId,
        sequence: ++this.sequence,
        type: event.type,
        timestamp: Date.now(),
        payload: event,
      };
      for (const listener of this.listeners) listener(envelope);
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.inner.sessionFile;
  }

  /** 创建全新 Session（无项目或绑定真实目录，cwd 由 Session Router 决定） */
  static async create(opts: CreateRuntimeOptions): Promise<PiRuntimeAdapter> {
    const agentDir = opts.agentDir ?? getAgentDir();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const settingsManager = SettingsManager.create(opts.cwd, agentDir);
    const model = opts.model ? resolveModel(modelRuntime, opts.model) : undefined;
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      ...(model ? { model } : {}),
    });
    return new PiRuntimeAdapter(session, modelRuntime, agentDir);
  }

  /** 恢复已有 Session（sessionId 不变，模型/thinking 从 sessionFile 恢复） */
  static async resume(opts: ResumeRuntimeOptions): Promise<PiRuntimeAdapter> {
    const agentDir = opts.agentDir ?? getAgentDir();
    const sessionManager = SessionManager.open(opts.sessionFile, undefined);
    const cwd = sessionManager.getCwd();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const model = opts.model ? resolveModel(modelRuntime, opts.model) : undefined;
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      ...(model ? { model } : {}),
    });
    return new PiRuntimeAdapter(session, modelRuntime, agentDir);
  }

  async getState(): Promise<SessionRuntimeState> {
    const model = this.inner.model;
    return {
      state: this.disposed
        ? "disposing"
        : this.inner.isStreaming
          ? "busy"
          : "ready",
      isStreaming: this.inner.isStreaming,
      isIdle: this.inner.isIdle,
      model: model
        ? { provider: model.provider, modelId: model.id }
        : undefined,
      thinkingLevel: this.inner.thinkingLevel,
      cwd: this.inner.sessionManager.getCwd(),
    };
  }

  /**
   * 发送普通 Prompt（默认串行：同一 Session 排队执行）。
   * streaming 中不带 streamingBehavior 时 Pi 原生会抛错，由调用方按 steer/follow_up 语义处理。
   */
  async prompt(message: string): Promise<PromptAck> {
    this.assertAlive();
    try {
      await this.inner.prompt(message);
      return { accepted: true, sessionId: this.sessionId };
    } catch (err) {
      return {
        accepted: false,
        sessionId: this.sessionId,
        reason: "error",
      };
    }
  }

  /** 执行命令面（C-2） */
  async sendCommand(command: SessionCommand): Promise<unknown> {
    this.assertAlive();
    switch (command.type) {
      case "prompt":
        return this.prompt(command.message);
      case "abort":
        await this.inner.abort();
        return { ok: true };
      case "steer":
        await this.inner.prompt(command.message, { streamingBehavior: "steer" });
        return { ok: true };
      case "follow_up":
        await this.inner.prompt(command.message, { streamingBehavior: "followUp" });
        return { ok: true };
      case "set_model":
        await this.setModel(command.model);
        return { ok: true };
      case "set_thinking_level": {
        const level = await this.setThinkingLevel(command.level);
        return { ok: true, level };
      }
      case "set_tools":
        this.inner.setActiveToolsByName(command.toolNames);
        return { ok: true };
      case "compact":
        await this.inner.compact();
        return { ok: true };
      case "get_state":
        return this.getState();
      default: {
        const _exhaustive: never = command;
        throw new Error(`unsupported command: ${String(_exhaustive)}`);
      }
    }
  }

  /** 订阅 Gateway Event（返回退订函数） */
  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async abort(): Promise<void> {
    this.assertAlive();
    await this.inner.abort();
  }

  async setModel(model: ModelSelection): Promise<void> {
    this.assertAlive();
    await this.inner.setModel(resolveModel(this.modelRuntime, model));
  }

  /**
   * 请求设置 thinking 级别，返回 SDK 按当前模型能力 clamp 后的实际生效值。
   * （不静默：调用方以返回值为准，产品层可展示真实生效级别）
   */
  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    this.assertAlive();
    this.inner.setThinkingLevel(level);
    return this.inner.thinkingLevel;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInner();
    this.listeners.clear();
    this.inner.dispose();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error(`runtime disposed: ${this.sessionId}`);
  }
}

function resolveModel(modelRuntime: ModelRuntime, sel: ModelSelection) {
  const model = modelRuntime.getModel(sel.provider, sel.modelId);
  if (!model) {
    throw new Error(`unknown model ${sel.provider}/${sel.modelId}`);
  }
  return model;
}
