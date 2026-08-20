"use client";

/**
 * ChannelsConfig（FR-102 渠道管理界面）
 *
 * 仿 nanobot 微信面板：状态徽章 / 扫码连接流程（二维码+轮询+验证码）/ 配置。
 * 容器与 pi-web 现有 Modal（ModelsConfig）一致；仅一期展示微信渠道。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useI18n } from "@/hooks/useI18n";
import type {
  ChannelConnectPayload,
  ChannelStatus,
} from "@/lib/personal-gateway";

const WECHAT_GREEN = "#07C160";

export function ChannelsConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [gatewayEnabled, setGatewayEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 连接流程状态
  const [connect, setConnect] = useState<ChannelConnectPayload | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/personal/channels", { cache: "no-store" });
      const data = await res.json();
      setGatewayEnabled(data.gatewayEnabled !== false);
      setChannels(data.channels ?? []);
      setError(data.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    // 面板打开期间每 10s 轮询状态（动态跟随 token 失效/断开等状态变化）
    const timer = setInterval(() => void loadStatus(), 10_000);
    return () => clearInterval(timer);
    // 加载渠道配置回填表单
    void fetch("/api/personal/channels/wechat/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        if (Array.isArray(cfg.allowFrom)) setAllowFrom(cfg.allowFrom.join(", "));
        if (typeof cfg.progressEnabled === "boolean") setProgressOn(cfg.progressEnabled);
        if (typeof cfg.toolHintsEnabled === "boolean") setToolHintsOn(cfg.toolHintsEnabled);
        if (typeof cfg.replyProgressEnabled === "boolean") setProgressMessagesOn(cfg.replyProgressEnabled);
        if (typeof cfg.replyProgressMax === "number") setProgressMax(cfg.replyProgressMax);
        if (typeof cfg.blockStreaming === "boolean") setBlockStreamingOn(cfg.blockStreaming);
        if (typeof cfg.blockMinChars === "number") setBlockMinChars(cfg.blockMinChars);
        if (typeof cfg.blockMaxMessages === "number") setBlockMaxMessages(cfg.blockMaxMessages);
      })
      .catch(() => {});
  }, [loadStatus]);

  useEffect(() => () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const wechat = channels[0];

  const startConnect = useCallback(async (force = false) => {
    setConnecting(true);
    setVerifyCode("");
    try {
      const res = await fetch("/api/personal/channels/wechat/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const payload = (await res.json()) as ChannelConnectPayload;
      setConnect(payload);
      if (payload.status === "pending" && payload.session_id) {
        schedulePoll(payload.session_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  const schedulePoll = useCallback((sessionId: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/personal/channels/wechat/connect?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const payload = (await res.json()) as ChannelConnectPayload;
        setConnect(payload);
        if (payload.status === "pending" && payload.session_id) {
          schedulePoll(payload.session_id);
        } else {
          void loadStatus();
        }
      } catch {
        // 轮询失败：稍后重试
        schedulePoll(sessionId);
      }
    };
    pollTimerRef.current = setTimeout(tick, 2000);
  }, [loadStatus]);

  const submitVerifyCode = useCallback(async () => {
    if (!connect?.session_id || !verifyCode.trim()) return;
    try {
      const res = await fetch(
        `/api/personal/channels/wechat/connect?session_id=${encodeURIComponent(connect.session_id)}&verify_code=${encodeURIComponent(verifyCode.trim())}`,
        { cache: "no-store" },
      );
      const payload = (await res.json()) as ChannelConnectPayload;
      setConnect(payload);
      if (payload.status === "pending" && payload.session_id) {
        schedulePoll(payload.session_id);
      } else {
        void loadStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [connect, verifyCode, schedulePoll, loadStatus]);

  const cancelConnect = useCallback(async () => {
    if (connect?.session_id) {
      await fetch("/api/personal/channels/wechat/connect/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: connect.session_id }),
      }).catch(() => {});
    }
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setConnect(null);
    void loadStatus();
  }, [connect, loadStatus]);

  // 断开连接：停止 transport 轮询（保留 token）
  const disconnectChannel = useCallback(async () => {
    setConnecting(true);
    try {
      await fetch("/api/personal/channels/wechat/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {}
    setConnecting(false);
    void loadStatus();
  }, [loadStatus]);

  // 连接：authExpired → 重新扫码；已断开且有 token → 直接恢复轮询；否则扫码
  const connectChannel = useCallback(async () => {
    if (wechat?.authExpired) {
      // token 已失效：必须重新扫码
      await startConnect(true);
      return;
    }
    if (wechat && !wechat.running && wechat.connected) {
      setConnecting(true);
      try {
        await fetch("/api/personal/channels/wechat/reconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {}
      setConnecting(false);
      void loadStatus();
      return;
    }
    await startConnect(false);
  }, [wechat, startConnect, loadStatus]);

  // 配置保存（真实映射到 Personal Runtime —— 一期为 config 传输，持久化在后续版本）
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [allowFrom, setAllowFrom] = useState("");
  const [progressOn, setProgressOn] = useState(true);
  const [toolHintsOn, setToolHintsOn] = useState(false);
  const [progressMessagesOn, setProgressMessagesOn] = useState(false);
  const [progressMax, setProgressMax] = useState(2);
  const [blockStreamingOn, setBlockStreamingOn] = useState(false);
  const [blockMinChars, setBlockMinChars] = useState(1200);
  const [blockMaxMessages, setBlockMaxMessages] = useState(3);

  const saveSettings = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/personal/channels/wechat/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowFrom: allowFrom.split(",").map((s) => s.trim()).filter(Boolean),
          progressEnabled: progressOn,
          toolHintsEnabled: toolHintsOn,
          replyProgressEnabled: progressMessagesOn,
          replyProgressMax: progressMax,
          blockStreaming: blockStreamingOn,
          blockMinChars: blockMinChars,
          blockMaxMessages: blockMaxMessages,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveState("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setTimeout(() => setSaveState("idle"), 1500);
    }
  }, [allowFrom, progressOn, toolHintsOn, progressMessagesOn, progressMax, blockStreamingOn, blockMinChars, blockMaxMessages]);

  const badge = (() => {
    if (!wechat) return null;
    if (wechat.authExpired) return { cls: "error", label: t("channels.authExpired") };
    if (wechat.running) return { cls: "on", label: t("channels.connected") };
    if (connecting || connect?.status === "pending") {
      return { cls: "connecting", label: t("channels.connecting") };
    }
    return { cls: "off", label: t("channels.notConnected") };
  })();

  const connectMessage = (() => {
    if (!connect) return "";
    switch (connect.status) {
      case "succeeded": return t("channels.connectSucceeded");
      case "expired": return t("channels.connectExpired");
      case "failed": return connect.message ?? t("channels.connectFailed");
      case "cancelled": return t("channels.connectCancelled");
      case "pending":
        if (connect.challenge === "verify_code") {
          return connect.verification_failed
            ? t("channels.verifyMismatch")
            : t("channels.verifyRequired");
        }
        return t("channels.waitingScan");
      default: return "";
    }
  })();

  const showQr = connect && connect.status === "pending" && connect.qr_url && (!wechat?.running || wechat?.authExpired);

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ width: 440, maxWidth: "calc(100vw - 16px)", maxHeight: "86vh", overflow: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("common.channels")}</span>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }} aria-label={t("common.close")}>×</button>
          </div>

          {/* Body */}
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            {!gatewayEnabled && (
              <div style={{ fontSize: 12, color: "#dc2626", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "8px 10px" }}>
                {t("channels.gatewayDisabled")}
              </div>
            )}
            {error && (
              <div style={{ fontSize: 12, color: "#dc2626", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "8px 10px" }}>{error}</div>
            )}

            {/* 微信卡片 */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: WECHAT_GREEN, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M9.5 3C5.4 3 2 5.8 2 9.3c0 2 1.1 3.7 2.9 4.9l-.7 2.1 2.4-1.2c.7.2 1.5.3 2.4.3h.4a5 5 0 0 1-.2-1.4c0-3 2.9-5.4 6.4-5.4h.4C15.4 5.2 12.8 3 9.5 3zm-2.4 4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm4.8 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM15 11c-3 0-5.4 2-5.4 4.4 0 2.4 2.4 4.4 5.4 4.4.7 0 1.4-.1 2-.3l2 1-.5-1.7c1.4-.9 2.3-2.2 2.3-3.6 0-2.4-2.4-4.2-5.8-4.2zm-2 2.7a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zm4 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z"/></svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("channels.wechat")}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>
                  {t("channels.wechatDesc")}
                </div>
              </div>
              <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                {badge && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
                    ...(badge.cls === "on" ? { background: "rgba(34,197,94,0.12)", color: "#16a34a" }
                      : badge.cls === "connecting" ? { background: "rgba(37,99,235,0.10)", color: "var(--accent)" }
                      : badge.cls === "error" ? { background: "rgba(239,68,68,0.10)", color: "#dc2626" }
                      : { background: "var(--bg-subtle)", color: "var(--text-muted)" }) }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: badge.cls === "on" ? "#22c55e" : badge.cls === "connecting" ? "var(--accent)" : badge.cls === "error" ? "#ef4444" : "var(--text-dim)" }} />
                    {badge.label}
                  </span>
                )}
                {wechat?.running && !wechat?.authExpired ? (
                  <button onClick={() => { void disconnectChannel(); }} style={{ background: "none", border: "1px solid rgba(239,68,68,0.35)", color: "#dc2626", borderRadius: 6, cursor: "pointer", fontSize: 11, padding: "4px 10px" }}>{t("channels.disconnect")}</button>
                ) : (
                  <button onClick={() => { void connectChannel(); }} disabled={connecting} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600, padding: "5px 12px", opacity: connecting ? 0.6 : 1 }}>{t("channels.connect")}</button>
                )}
              </div>
            </div>

            {/* 连接流程（二维码） */}
            {showQr && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("channels.scanTitle")}</div>
                <div style={{ width: 200, height: 200, background: "#fff", border: "1px solid var(--border)", borderRadius: 8, display: "grid", placeItems: "center", overflow: "hidden" }}>
                  <QRCodeSVG value={connect?.qr_url ?? ""} size={190} />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  {connect?.challenge !== "verify_code" && <span style={{ width: 12, height: 12, border: "2px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />}
                  {connectMessage}
                </div>
                {connect?.challenge === "verify_code" && (
                  <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 260 }}>
                    <input
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value)}
                      inputMode="numeric"
                      placeholder={t("channels.verifyPlaceholder")}
                      style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
                    />
                    <button onClick={() => void submitVerifyCode()} disabled={!verifyCode.trim()} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "7px 14px", opacity: verifyCode.trim() ? 1 : 0.5 }}>{t("channels.verifySubmit")}</button>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => void startConnect(true)} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 6, cursor: "pointer", fontSize: 11, padding: "4px 10px" }}>{t("channels.refreshQr")}</button>
                  <button onClick={() => void cancelConnect()} style={{ background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", borderRadius: 6, cursor: "pointer", fontSize: 11, padding: "4px 10px" }}>{t("channels.cancel")}</button>
                </div>
              </div>
            )}

            {/* 主设置 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <SettingRow title={t("channels.allowFrom")} hint={t("channels.allowFromHint")}>
                <input value={allowFrom} onChange={(e) => setAllowFrom(e.target.value)} placeholder="wxid_xxx, wxid_yyy" style={{ width: 180, flexShrink: 0, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none" }} />
              </SettingRow>
              <SettingRow title={t("channels.progressHint")} hint={t("channels.progressHintDesc")}>
                <Toggle checked={progressOn} onChange={setProgressOn} />
              </SettingRow>
              <SettingRow title={t("channels.toolHints")} hint={t("channels.toolHintsDesc")}>
                <Toggle checked={toolHintsOn} onChange={setToolHintsOn} />
              </SettingRow>
            </div>

            {/* 高级设置 */}
            <details style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", padding: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--text)", listStyle: "none", display: "flex", alignItems: "center", gap: 6 }}>{t("channels.advanced")}</summary>
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                <SettingRow title={t("channels.replyProgress")} hint={t("channels.replyProgressDesc")}>
                  <Toggle checked={progressMessagesOn} onChange={setProgressMessagesOn} />
                </SettingRow>
                <SettingRow title={t("channels.replyProgressMax")} hint={t("channels.replyProgressMaxDesc")}>
                  <NumberInput value={progressMax} onChange={setProgressMax} min={0} max={4} />
                </SettingRow>
                <SettingRow title={t("channels.blockStreaming")} hint={t("channels.blockStreamingDesc")}>
                  <Toggle checked={blockStreamingOn} onChange={setBlockStreamingOn} />
                </SettingRow>
                <SettingRow title={t("channels.blockMinChars")} hint={t("channels.blockMinCharsDesc")}>
                  <NumberInput value={blockMinChars} onChange={setBlockMinChars} min={200} max={1800} step={100} />
                </SettingRow>
                <SettingRow title={t("channels.blockMaxMessages")} hint={t("channels.blockMaxMessagesDesc")}>
                  <NumberInput value={blockMaxMessages} onChange={setBlockMaxMessages} min={1} max={4} />
                </SettingRow>
              </div>
            </details>

            {/* 保存 */}
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
              {saving && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("channels.saving")}</span>}
              {!saving && saveState === "saved" && <span style={{ fontSize: 11, color: "#16a34a" }}>{t("channels.saved")}</span>}
              <button onClick={() => void saveSettings()} disabled={saving} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "6px 16px", opacity: saving ? 0.6 : 1 }}>{t("common.save")}</button>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function SettingRow({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{title}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>{hint}</div>
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      aria-label={checked ? "on" : "off"}
      style={{ width: 34, height: 20, borderRadius: 999, background: checked ? "var(--accent)" : "var(--border)", position: "relative", cursor: "pointer", border: "none", flexShrink: 0, transition: "background 0.2s" }}
    >
      <span style={{ position: "absolute", top: 2, left: checked ? 16 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
    </button>
  );
}

function NumberInput({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width: 64, flexShrink: 0, padding: "5px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none" }}
    />
  );
}
