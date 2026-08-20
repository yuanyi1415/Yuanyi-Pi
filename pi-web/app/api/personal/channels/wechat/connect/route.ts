import { NextResponse } from "next/server";
import {
  gatewayChannelConnectCancel,
  gatewayChannelConnectPoll,
  gatewayChannelConnectStart,
  gatewayEnabled,
} from "@/lib/personal-gateway";

export const dynamic = "force-dynamic";

// 渠道扫码连接流程（BFF 转发到 Personal Gateway）
// POST /api/personal/channels/wechat/connect  body: { force? } → 开始扫码
// GET  /api/personal/channels/wechat/connect?session_id=&verify_code= → 轮询
// POST /api/personal/channels/wechat/connect/cancel  body: { session_id } → 取消
export async function POST(req: Request) {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith("/cancel")) {
      const body = (await req.json().catch(() => ({}))) as { session_id?: string };
      return NextResponse.json(await gatewayChannelConnectCancel(body.session_id ?? ""));
    }
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    return NextResponse.json(await gatewayChannelConnectStart(Boolean(body.force)));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  if (!gatewayEnabled()) {
    return NextResponse.json({ error: "gateway_disabled" }, { status: 503 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id") ?? "";
  const verifyCode = url.searchParams.get("verify_code") ?? "";
  try {
    return NextResponse.json(await gatewayChannelConnectPoll(sessionId, verifyCode));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
