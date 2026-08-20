/**
 * 微信登录状态持久化（照抄 nanobot _load_state / _save_state）
 *
 * account.json：{ token, get_updates_buf, context_tokens, typing_tickets,
 *                  base_url, replaced_config_token_sha256 }
 * - 并发 QR 登录可能写入更新的 token，旧 runtime 快照不得覆盖
 * - 原子写（临时文件 + rename）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WechatAccountState {
  token: string;
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
  baseUrl: string;
  /** 替换了配置 token 的 sha256（重新手动配置后失效） */
  replacedConfigTokenHash: string;
}

export class WechatStateStore {
  private stateDir: string;

  constructor(
    stateDir: string,
    private readonly configuredToken = "",
  ) {
    this.stateDir = stateDir;
  }

  setStateDir(dir: string): void {
    this.stateDir = dir;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  static tokenFingerprint(token: string): string {
    return token ? createHash("sha256").update(token).digest("hex") : "";
  }

  private stateFile(): string {
    return join(this.stateDir, "account.json");
  }

  /**
   * 加载状态。requiredReplacedConfigToken 非空时校验替换哈希（照抄
   * _load_state(required_replaced_config_token=...)）
   */
  load(requiredReplacedConfigToken?: string): WechatAccountState | null {
    const file = this.stateFile();
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const replacedHash = String(data.replaced_config_token_sha256 ?? "");
      if (
        requiredReplacedConfigToken !== undefined &&
        replacedHash !== WechatStateStore.tokenFingerprint(requiredReplacedConfigToken)
      ) {
        return null;
      }
      const contextTokens: Record<string, string> = {};
      if (data.context_tokens && typeof data.context_tokens === "object") {
        for (const [k, v] of Object.entries(data.context_tokens as Record<string, unknown>)) {
          const s = String(v ?? "").trim();
          if (k.trim() && s) contextTokens[k] = s;
        }
      }
      return {
        token: String(data.token ?? ""),
        getUpdatesBuf: String(data.get_updates_buf ?? ""),
        contextTokens,
        baseUrl: String(data.base_url ?? ""),
        replacedConfigTokenHash: replacedHash,
      };
    } catch {
      return null;
    }
  }

  /**
   * 保存状态。照抄 _save_state 的防覆盖逻辑：
   * - 持久化的 token 更新（非本 runtime 配置 token 权威时）→ 不覆盖
   */
  save(
    token: string,
    getUpdatesBuf: string,
    contextTokens: Record<string, string>,
    baseUrl: string,
    replacedConfigTokenHash = "",
    force = false,
  ): void {
    const file = this.stateFile();
    let shouldWrite = true;
    if (!force && existsSync(file)) {
      try {
        const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const persistedToken = String(persisted.token ?? "");
        const persistedReplacedHash = String(persisted.replaced_config_token_sha256 ?? "");
        const persistedReplacesConfigToken =
          Boolean(this.configuredToken) &&
          persistedReplacedHash === WechatStateStore.tokenFingerprint(this.configuredToken);
        const configuredTokenIsAuthoritative =
          Boolean(this.configuredToken) &&
          token === this.configuredToken &&
          !persistedReplacesConfigToken;
        if (
          persistedToken &&
          persistedToken !== token &&
          !configuredTokenIsAuthoritative
        ) {
          // 并发 QR 登录已提交更新的 token：旧快照不得覆盖
          shouldWrite = false;
        }
      } catch {
        // 损坏文件允许覆盖
      }
    }
    if (!shouldWrite) return;

    mkdirSync(dirname(file), { recursive: true });
    const payload: Record<string, unknown> = {
      token,
      get_updates_buf: getUpdatesBuf,
      context_tokens: contextTokens,
      base_url: baseUrl,
    };
    if (replacedConfigTokenHash) {
      payload.replaced_config_token_sha256 = replacedConfigTokenHash;
    }
    const tmp = join(this.stateDir, `.account.json.tmp`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
  }
}
