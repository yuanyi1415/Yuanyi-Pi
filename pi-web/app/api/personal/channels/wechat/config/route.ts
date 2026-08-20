import { NextResponse } from "next/server";
import { gatewayChannelConfig, gatewayChannelSaveConfig, gatewayEnabled } from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// GET /api/personal/channels/wechat/config → 读取渠道配置
export async function GET() {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  try {
    return NextResponse.json(await gatewayChannelConfig());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

// PUT /api/personal/channels/wechat/config → 保存渠道配置（即时生效）
export async function PUT(req: Request) {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await gatewayChannelSaveConfig(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
