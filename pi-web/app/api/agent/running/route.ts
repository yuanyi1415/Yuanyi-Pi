import { NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { gatewayEnabled, gatewayListSessions, legacyRuntimeEnabled, runtimeUnavailableResponse } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  if (gatewayEnabled()) {
    const { sessions } = await gatewayListSessions();
    return NextResponse.json(
      { runningSessionIds: sessions.filter((session) => session.running).map((session) => session.sessionId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
  return NextResponse.json(
    { runningSessionIds: getRunningRpcSessionIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
