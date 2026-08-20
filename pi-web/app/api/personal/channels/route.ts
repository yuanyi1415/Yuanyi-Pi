import { NextResponse } from "next/server";
import { gatewayChannelStatus, gatewayEnabled } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// GET /api/personal/channels - 渠道状态列表（一期仅微信）
export async function GET() {
  if (!gatewayEnabled()) {
    return NextResponse.json({ channels: [], gatewayEnabled: false });
  }
  try {
    const status = await gatewayChannelStatus();
    return NextResponse.json({
      gatewayEnabled: true,
      channels: [{ channelType: "wechat", ...status }],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
