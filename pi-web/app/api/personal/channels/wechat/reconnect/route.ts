import { NextResponse } from "next/server";
import { gatewayChannelReconnect, gatewayEnabled } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// POST /api/personal/channels/wechat/reconnect → 重新连接（恢复轮询，免扫码）
export async function POST() {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  try {
    return NextResponse.json(await gatewayChannelReconnect());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
