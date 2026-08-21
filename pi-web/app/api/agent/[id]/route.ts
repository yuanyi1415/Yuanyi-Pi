import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import {
  gatewayCommand, gatewayEnabled, gatewayGetSession,
  legacyRuntimeEnabled, runtimeUnavailableResponse,
} from "@/lib/personal-gateway";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (gatewayEnabled()) return gatewayPost(req, id);
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  return legacyPost(req, id);
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (gatewayEnabled()) return gatewayGet(_req, id);
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  return legacyGet(_req, id);
}

// ---------- Personal Gateway 路径（DEV312） ----------
async function gatewayPost(req: Request, id: string) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    const result = await gatewayCommand(id, body, {
      requestId: req.headers.get("x-yuanyi-request-id") ?? undefined,
      t0: req.headers.get("x-yuanyi-t0") ?? undefined,
    });
    promptAccepted = body.type === "prompt";
    if (body.type === "prompt" && !(result as { accepted?: boolean }).accepted) {
      return NextResponse.json({
        error: "prompt rejected",
        code: "prompt_rejected",
        accepted: false,
      }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status });
  }
}

async function gatewayGet(_req: Request, id: string) {
  try {
    const descriptor = await gatewayGetSession(id);
    if (!descriptor.running) {
      return NextResponse.json({ running: false });
    }
    const state = await gatewayCommand(id, { type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    // Gateway 侧 session 不存在 → 与旧行为一致返回 running:false
    if ((error as { status?: number }).status === 404) {
      return NextResponse.json({ running: false });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// ---------- 原 rpc-manager 路径（回退） ----------
async function legacyPost(
  req: Request,
  id: string,
): Promise<Response> {
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

async function legacyGet(
  _req: Request,
  id: string,
): Promise<Response> {
  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
