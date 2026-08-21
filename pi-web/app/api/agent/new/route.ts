import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import {
  gatewayCommand,
  gatewayCreateSession,
  gatewayEnabled,
  legacyRuntimeEnabled,
  runtimeUnavailableResponse,
} from "@/lib/personal-gateway";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

function promptRejected(code: string, message: string) {
  return NextResponse.json({
    error: message,
    code: "prompt_rejected",
    accepted: false,
  }, { status: 400 });
}

// POST /api/agent/new  body: { cwd?: string; type: string; message?: string; ... }
// Prepares a brand-new runtime without persisting Session/Project metadata;
// the first prompt commits the pending draft on the Gateway side.
// Returns pi's real session id plus the model/thinking state selected at startup.
//
// Personal Gateway 模式（PERSONAL_GATEWAY_ENABLED=1）：
// - cwd 可选：缺省 → 话题 Session（projectDirectory=null → 独立 workspace）
// - 通过 Personal Gateway 创建并执行首条命令（Runtime Ownership 在 Personal Runtime）
export async function POST(req: Request) {
  if (gatewayEnabled()) return gatewayNewSession(req);
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  return legacyNewSession(req);
}

// ---------- Personal Gateway 路径（DEV312） ----------
async function gatewayNewSession(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (cwd && !existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as {
      provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown;
      [key: string]: unknown;
    };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    const descriptor = await gatewayCreateSession({
      projectDirectory: cwd ? cwd : null,
      projectDisplayName: typeof command.projectDisplayName === "string" ? command.projectDisplayName : null,
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
    });
    const sessionId = descriptor.sessionId;

    if (cwd) allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await gatewayCommand(sessionId, { type: "get_state" }) as {
      model?: { provider: string; modelId: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.modelId }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await gatewayCommand(sessionId, promptCommand);
    promptAccepted = promptCommand.type === "prompt";
    if (promptCommand.type === "prompt" && !(result as { accepted?: boolean }).accepted) {
      return promptRejected("prompt_rejected", "prompt rejected");
    }

    return NextResponse.json({
      success: true,
      sessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.modelId }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    const gatewayCode = (error as { code?: string }).code;
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      // Gateway 明确错误（runtime_unavailable 等）优先；否则按 prompt 受理判定
      ...(gatewayCode ? { code: gatewayCode, accepted: false } : {}),
      ...(commandType === "prompt" && !promptAccepted && !gatewayCode
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status });
  }
}

// ---------- 原 rpc-manager 路径（回退开关关闭时保持原行为） ----------
async function legacyNewSession(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
