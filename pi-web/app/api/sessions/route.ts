import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { gatewayEnabled, gatewayListSessions, legacyRuntimeEnabled, runtimeUnavailableResponse } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (gatewayEnabled()) return gatewayList(req);
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  return legacyList(req);
}

// ---------- Personal Gateway 路径（DEV312） ----------
async function gatewayList(req: Request) {
  try {
    const { sessions } = await gatewayListSessions();
    const webSessions = sessions.map((s) => ({
      id: s.sessionId,
      path: "",
      cwd: s.projectDirectory ?? "",
      projectRoot: s.projectDirectory ?? undefined,
      projectDisplayName: s.projectDisplayName,
      name: s.title ?? "",
      created: s.createdAt
        ? new Date(s.createdAt).toISOString()
        : new Date(0).toISOString(),
      modified: s.updatedAt
        ? new Date(s.updatedAt).toISOString()
        : new Date(s.createdAt ?? 0).toISOString(),
      messageCount: 0,
      firstMessage: "(no messages)",
      parentSessionId: undefined,
      transient: false,
    }));
    return NextResponse.json(
      {
        sessions: webSessions,
        runningSessionIds: sessions.filter((s) => s.running).map((s) => s.sessionId),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: String(error) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// ---------- 原 rpc-manager 路径（回退） ----------
async function legacyList(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
