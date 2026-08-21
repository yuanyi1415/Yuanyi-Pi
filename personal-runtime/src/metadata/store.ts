/**
 * MetadataStore（DEV214）
 *
 * 只保存 Personal 产品元数据，不复制 Pi 对话正文（技术设计 4.2 / AD R-005）。
 * 原子写入：临时文件 + rename；Node 单线程同步写即串行。
 *
 * 结构：
 * {
 *   version: 1,
 *   sessions: { "<sessionId>": { projectDirectory, originChannel, modelPresetId } },
 *   channelBindings: { "wechat": { "<accountId>:<contactId>": { activeSessionId } } }
 * }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionMeta {
  /** 用户显式绑定的真实本地目录；null = 无项目 */
  projectDirectory: string | null;
  /** Session 创建来源 Channel */
  originChannel?: "web" | "wechat";
  /** 可选产品引用，不承担运行事实 */
  modelPresetId?: string | null;
}

export interface KnownProject {
  path: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelBinding {
  activeSessionId: string;
}

interface MetadataFile {
  version: 1;
  projects: Record<string, KnownProject>;
  sessions: Record<string, SessionMeta>;
  channelBindings: Record<string, Record<string, ChannelBinding>>;
}

export function channelKey(accountId: string, contactId: string): string {
  return `${accountId}:${contactId}`;
}

export class MetadataStore {
  private data: MetadataFile = { version: 1, projects: {}, sessions: {}, channelBindings: {} };

  constructor(private readonly filePath: string) {}

  /** 从磁盘加载；文件不存在时使用空结构 */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object" && raw.version === 1) {
        this.data = {
          version: 1,
          projects: raw.projects ?? {},
          sessions: raw.sessions ?? {},
          channelBindings: raw.channelBindings ?? {},
        };
      }
    } catch (err) {
      // 损坏的 metadata 不覆盖：保留在内存空结构，后续写入会覆盖
      console.error("[personal-runtime] metadata load failed:", err);
    }
  }

  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.data.sessions[sessionId];
  }

  getSessionMetaAll(): Record<string, SessionMeta> {
    return this.data.sessions;
  }

  getProjects(): KnownProject[] {
    return Object.values(this.data.projects).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getProject(path: string): KnownProject | undefined {
    return this.data.projects[path];
  }

  upsertProject(path: string, displayName: string, now = Date.now()): KnownProject {
    const existing = this.data.projects[path];
    const project: KnownProject = {
      path,
      displayName: displayName.trim() || existing?.displayName || path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.projects[path] = project;
    this.save();
    return project;
  }

  renameProject(path: string, displayName: string): KnownProject | undefined {
    const existing = this.data.projects[path];
    if (!existing) return undefined;
    const project = { ...existing, displayName: displayName.trim(), updatedAt: Date.now() };
    this.data.projects[path] = project;
    this.save();
    return project;
  }

  removeProject(path: string): boolean {
    if (!(path in this.data.projects)) return false;
    delete this.data.projects[path];
    this.save();
    return true;
  }

  setSessionMeta(sessionId: string, meta: SessionMeta): void {
    this.data.sessions[sessionId] = meta;
    this.save();
  }

  removeSessionMeta(sessionId: string): void {
    if (sessionId in this.data.sessions) {
      delete this.data.sessions[sessionId];
      this.save();
    }
  }

  getBinding(channelType: string, key: string): ChannelBinding | undefined {
    return this.data.channelBindings[channelType]?.[key];
  }

  setBinding(channelType: string, key: string, binding: ChannelBinding): void {
    this.data.channelBindings[channelType] ??= {};
    this.data.channelBindings[channelType][key] = binding;
    this.save();
  }

  removeBinding(channelType: string, key: string): void {
    const channel = this.data.channelBindings[channelType];
    if (channel) {
      delete channel[key];
      this.save();
    }
  }

  removeBindingsForSession(sessionId: string): void {
    let changed = false;
    for (const bindings of Object.values(this.data.channelBindings)) {
      for (const [key, binding] of Object.entries(bindings)) {
        if (binding.activeSessionId === sessionId) {
          delete bindings[key];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  /** 原子写：临时文件 + rename 替换 */
  private save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.metadata.json.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}
