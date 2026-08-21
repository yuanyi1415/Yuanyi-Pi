import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { gatewayCommand, gatewayEnabled, gatewayGetSession, legacyRuntimeEnabled, runtimeUnavailableResponse } from "@/lib/personal-gateway";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (gatewayEnabled()) {
      const descriptor = await gatewayGetSession(id);
      if (!descriptor.running) return NextResponse.json({ running: false });
      const state = await gatewayCommand(id, { type: "get_state" });
      return NextResponse.json({ running: true, state });
    }
    if (!legacyRuntimeEnabled()) return runtimeUnavailableResponse();
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
