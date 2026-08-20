import { NextResponse } from "next/server";
import { gatewayChannelConnectCancel, gatewayEnabled } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// POST /api/personal/channels/wechat/connect/cancel  body: { session_id } → 取消扫码
export async function POST(req: Request) {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { session_id?: string };
    return NextResponse.json(await gatewayChannelConnectCancel(body.session_id ?? ""));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
