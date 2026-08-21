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
  /** 运行目录 */
  cwd: string;
  /** 可选的产品层 Session ID（用于为无项目 Session 预分配工作区） */
  sessionId?: string;
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
  private activeRequestId: string | undefined;
  private readonly firstOutputRequestIds = new Set<string>();

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
        ...(this.activeRequestId ? { requestId: this.activeRequestId } : {}),
        payload: event,
      };
      if (
        this.activeRequestId
        && (event.type === "message_start" || event.type === "message_update")
        && !this.firstOutputRequestIds.has(this.activeRequestId)
      ) {
        this.firstOutputRequestIds.add(this.activeRequestId);
        console.info("[perf]", JSON.stringify({
          phase: "T2",
          requestId: this.activeRequestId,
          sessionId: this.sessionId,
          at: envelope.timestamp,
        }));
      }
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
    const sessionManager = opts.sessionId
      ? SessionManager.create(opts.cwd, join(agentDir, "sessions"), { id: opts.sessionId })
      : undefined;
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      ...(sessionManager ? { sessionManager } : {}),
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
      ...((this.inner.agent.state as { streamingMessage?: unknown }).streamingMessage
        ? { streamingMessage: (this.inner.agent.state as { streamingMessage?: unknown }).streamingMessage }
        : {}),
    };
  }

  /**
   * 发送普通 Prompt（默认串行：同一 Session 排队执行）。
   * streaming 中不带 streamingBehavior 时 Pi 原生会抛错，由调用方按 steer/follow_up 语义处理。
   *
   * 事务语义（S6-01，IssueLog-006）：Commit Point = Pi 原生 `preflightResult(success)` 时刻，
   * 而非整轮 Prompt 执行结束。
   * - preflight rejected（无模型/无认证等）→ 返回 `{ accepted: false, reason: "preflight_rejected" }`，不抛错；
   * - preflight accepted → 通过 `onPreflight` 实时通知调用方（Gateway 立即 commit/finalize），
   *   随后 Agent 正式执行；执行期抛错 → 重新抛出并标记 `promptAccepted`，避免上层回滚已成立 Session。
   *
   * Pi 原生 preflightResult 为同步回调，不能 await：onPreflight 内只做同步事务（commit/finalize 均为同步写盘），
   * 保证 Pi 进入 Agent Loop 前 Session 已正式化。
   */
  async prompt(
    message: string,
    requestId?: string,
    onPreflight?: (accepted: boolean) => void,
  ): Promise<PromptAck> {
    this.assertAlive();
    this.activeRequestId = requestId;
    let preflightAccepted = false;
    try {
      await this.inner.prompt(message, {
        preflightResult: (success) => {
          preflightAccepted = success;
          if (onPreflight) onPreflight(success);
        },
      });
      return { accepted: true, sessionId: this.sessionId };
    } catch (err) {
      if (preflightAccepted) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        (wrapped as Error & { promptAccepted?: boolean }).promptAccepted = true;
        throw wrapped;
      }
      return { accepted: false, sessionId: this.sessionId, reason: "preflight_rejected" };
    } finally {
      this.activeRequestId = undefined;
    }
  }

  /** 执行命令面（C-2） */
  async sendCommand(command: SessionCommand, requestId?: string): Promise<unknown> {
    this.assertAlive();
    switch (command.type) {
      case "prompt":
        return this.prompt(command.message, requestId);
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
      case "set_session_name": {
        const name = command.name.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        return { ok: true };
      }
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

  /** 使用当前 Agent 的模型与历史生成标题；不创建第二个 AgentSession。 */
  async generateSessionTitle(): Promise<{ title: string; usage?: unknown }> {
    await this.inner.waitForIdle();
    const source = this.inner.agent as any;
    const messages = source.state.messages as Array<any>;
    if (!messages.some((message) => message.role === "user" || message.role === "compactionSummary")) {
      throw new Error("The session has no user messages to name");
    }
    const titlePrompt = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;
    const shadowTools = source.state.tools.map((tool: any) => ({
      ...tool,
      execute: async () => { throw new Error("Tools cannot be executed while generating a session title"); },
    }));
    const safeMessages = messages.map((message) => (
      message.role === "assistant"
        ? { ...message, content: message.content.filter((block: any) => block.type !== "toolCall" ||
            messages.some((candidate) => candidate.role === "toolResult" && candidate.toolCallId === block.id)) }
        : message
    ));
    const last = safeMessages.at(-1);
    const initialMessages = last?.role === "user"
      ? [...safeMessages.slice(0, -1), {
        ...last,
        content: typeof last.content === "string"
          ? `${last.content}\n\n${titlePrompt}`
          : [...last.content, { type: "text", text: titlePrompt }],
      }]
      : safeMessages;
    const AgentConstructor = source.constructor as new (options: Record<string, unknown>) => any;
    const temporaryAgent = new AgentConstructor({
      initialState: {
        systemPrompt: source.state.systemPrompt,
        model: source.state.model,
        thinkingLevel: source.state.thinkingLevel,
        tools: shadowTools,
        messages: initialMessages,
      },
      convertToLlm: source.convertToLlm,
      transformContext: source.transformContext,
      streamFn: source.streamFunction,
      getApiKey: source.getApiKey,
      onPayload: source.onPayload,
      onResponse: source.onResponse,
      steeringMode: source.steeringMode,
      followUpMode: source.followUpMode,
      sessionId: source.sessionId,
      thinkingBudgets: source.thinkingBudgets,
      transport: source.transport,
      maxRetryDelayMs: source.maxRetryDelayMs,
      toolExecution: source.toolExecution,
    });
    const historyLength = safeMessages.length;
    const runPromise = last?.role === "user"
      ? temporaryAgent.continue()
      : temporaryAgent.prompt(titlePrompt);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        runPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            temporaryAgent.abort();
            reject(new Error("Session title generation timed out"));
          }, 90_000);
        }),
      ]);
    } catch (error) {
      temporaryAgent.abort();
      await runPromise.catch(() => {});
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const generated = temporaryAgent.state.messages.slice(historyLength).reverse().find((message: any) => message.role === "assistant");
    if (!generated) throw new Error("The model did not return a session title");
    if (generated.stopReason === "error") throw new Error(generated.errorMessage || "The title model request failed");
    const raw = generated.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n").trim();
    const title = raw.replace(/^```(?:text)?\s*|\s*```$/gi, "").split(/\r?\n/, 1)[0]
      .replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "")
      .replace(/[。.!]+$/u, "").trim().slice(0, 80);
    if (!/[\p{L}\p{N}]/u.test(title)) throw new Error("The model did not return a usable session title");
    return {
      title,
      ...(generated.usage ? { usage: generated.usage } : {}),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInner();
    this.listeners.clear();
    this.firstOutputRequestIds.clear();
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
