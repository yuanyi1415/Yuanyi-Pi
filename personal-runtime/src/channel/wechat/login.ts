/**
 * 微信 QR 扫码登录状态机（照抄 nanobot _qr_login / connect.py）
 *
 * 状态：wait → confirmed（成功）/ expired（刷新≤3 次）/ need_verifycode（回调输入）
 *      / verify_code_blocked（刷新）/ scaned_but_redirect（切换 base_url）
 *      / binded_redirect（已有绑定）
 */
import { MAX_QR_REFRESH_COUNT, type QrStatus, type QrStatusResponse } from "./types";
import { IlinkClient } from "./ilink";

export interface QrLoginResult {
  ok: boolean;
  token?: string;
  baseUrl?: string;
  botId?: string;
  userId?: string;
  reason?: string;
}

export interface QrLoginOptions {
  /** 强制重新登录（不使用本地凭据） */
  force?: boolean;
  /** 需要输入验证码时回调（返回用户输入） */
  onVerifyCode?: (prompt: string) => Promise<string>;
  /** 打印/展示二维码（URL 或二维码图内容） */
  onQrCode?: (scanUrl: string) => void;
  /** 是否停止轮询（登录被取消） */
  shouldStop?: () => boolean;
  /** 轮询间隔 ms */
  pollIntervalMs?: number;
}

/** 重试性轮询错误判定（照抄 _is_retryable_qr_poll_error） */
function isRetryableQrPollError(err: unknown): boolean {
  if (err instanceof Error && "status" in err) {
    const status = (err as Error & { status: number }).status;
    return IlinkClient.isRetryableHttpStatus(status);
  }
  // fetch 网络错误/超时（TypeError: fetch failed / AbortError timeout）
  return true;
}

/**
 * 扫码登录。返回 token（成功后）。轮询期间调用 onQrCode 展示二维码。
 */
export async function qrLogin(
  client: IlinkClient,
  baseUrl: string,
  opts: QrLoginOptions = {},
): Promise<QrLoginResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const shouldStop = opts.shouldStop ?? (() => false);

  const fetchQr = async (localTokens: string[]): Promise<{ qrcodeId: string; scanUrl: string }> => {
    let qr;
    try {
      qr = await client.fetchQrCode(localTokens);
    } catch (err) {
      // 本地凭据被拒（-3）时重试空列表（照抄 nanobot）
      if (
        localTokens.length > 0 &&
        err instanceof Error &&
        /invalid argument|code=-3|errcode=-3/.test(err.message)
      ) {
        qr = await client.fetchQrCode([]);
      } else {
        throw err;
      }
    }
    return qr;
  };

  let refreshCount = 0;
  const force = opts.force ?? false;
  let qr = await fetchQr(force ? [] : localTokenList(client, force));
  opts.onQrCode?.(qr.scanUrl);
  let currentBaseUrl = baseUrl;
  let verifyCode = "";

  while (!shouldStop()) {
    let statusData: Record<string, unknown>;
    try {
      statusData = await client.pollQrStatus(qr.qrcodeId, currentBaseUrl, verifyCode);
    } catch (err) {
      if (isRetryableQrPollError(err)) {
        await sleep(pollIntervalMs);
        continue;
      }
      throw err;
    }
    if (!statusData || typeof statusData !== "object") {
      await sleep(pollIntervalMs);
      continue;
    }

    const status = String(statusData.status ?? "") as QrStatus;

    if (status === "confirmed") {
      const token = String(statusData.bot_token ?? "");
      const base = String(statusData.baseurl ?? "");
      if (token) {
        return {
          ok: true,
          token,
          baseUrl: base || undefined,
          botId: String(statusData.ilink_bot_id ?? ""),
          userId: String(statusData.ilink_user_id ?? ""),
        };
      }
      return { ok: false, reason: "Login confirmed but no bot_token in response" };
    }

    if (status === "scaned_but_redirect") {
      const redirectHost = String(statusData.redirect_host ?? "").trim();
      if (redirectHost) {
        const redirectedBase = redirectHost.startsWith("http")
          ? redirectHost
          : `https://${redirectHost}`;
        if (redirectedBase !== currentBaseUrl) currentBaseUrl = redirectedBase;
      }
      continue;
    }

    if (status === "need_verifycode") {
      if (opts.onVerifyCode) {
        const prompt = verifyCode
          ? "The previous code did not match. Enter the number shown in WeChat: "
          : "Enter the number shown in WeChat to continue: ";
        verifyCode = (await opts.onVerifyCode(prompt)).trim();
      }
      continue;
    }

    if (status === "verify_code_blocked") {
      verifyCode = "";
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        return { ok: false, reason: "WeChat verification failed too many times" };
      }
      qr = await fetchQr(force ? [] : localTokenList(client, force));
      currentBaseUrl = baseUrl;
      opts.onQrCode?.(qr.scanUrl);
      continue;
    }

    if (status === "binded_redirect") {
      if (opts.force) {
        return { ok: false, reason: "Forced login returned an existing binding without new credentials" };
      }
      // 已有绑定且本地有凭据 → 视为已连接（照抄 nanobot）
      return { ok: false, reason: "already_bound" };
    }

    if (status === "expired") {
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        return { ok: false, reason: `QR code expired too many times (${refreshCount - 1}/${MAX_QR_REFRESH_COUNT})` };
      }
      qr = await fetchQr(force ? [] : localTokenList(client, force));
      currentBaseUrl = baseUrl;
      verifyCode = "";
      opts.onQrCode?.(qr.scanUrl);
      continue;
    }

    // status == "wait" — 继续轮询
    await sleep(pollIntervalMs);
  }

  return { ok: false, reason: "cancelled" };
}

function localTokenList(client: IlinkClient, force: boolean): string[] {
  if (force) return [];
  const token = client.getToken();
  return token ? [token] : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
