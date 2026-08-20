import { NextResponse } from "next/server";
import {
  gatewayChannelDisconnect,
  gatewayChannelReconnect,
  gatewayEnabled,
} from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// POST /api/personal/channels/wechat/disconnect → 断开（停止轮询，保留 token）
// POST /api/personal/channels/wechat/reconnect → 重连（恢复轮询，免扫码）
export async function POST(req: Request) {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  const url = new URL(req.url);
  try {
    const status = url.pathname.endsWith("/reconnect")
      ? await gatewayChannelReconnect()
      : await gatewayChannelDisconnect();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
