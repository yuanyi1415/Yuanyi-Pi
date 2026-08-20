import { getNonEmptyString, toRecord } from "./common.js";
import { safeJsonStringify } from "./logging.js";
import type { PermissionCheckResult } from "./types.js";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer.js";

const STRUCTURED_EDIT_OPERATION_NAMES = new Set(["replace", "append", "prepend", "delete", "replace_text"]);

const TOOL_INPUT_PREVIEW_MAX_LENGTH = 200;
const TOOL_TEXT_SUMMARY_MAX_LENGTH = 80;

export function getStructuredEditPayloads(inputRecord: Record<string, unknown>): unknown[] {
  if (Array.isArray(inputRecord.edits)) {
    return inputRecord.edits;
  }

  if (typeof inputRecord.oldText === "string" && typeof inputRecord.newText === "string") {
    return [{ op: "replace_text", oldText: inputRecord.oldText, newText: inputRecord.newText }];
  }

  return [];
}

export function hasStructuredEditPayload(inputRecord: Record<string, unknown>): boolean {
  return getStructuredEditPayloads(inputRecord).some((edit) => {
    const editRecord = toRecord(edit);
    const op = typeof editRecord.op === "string" ? editRecord.op : "replace_text";
    return STRUCTURED_EDIT_OPERATION_NAMES.has(op)
      || (typeof editRecord.oldText === "string" && typeof editRecord.newText === "string");
  });
}

export function formatMissingToolNameReason(): string {
  return "工具调用因未提供工具名而被拦截。请使用 pi.getAllTools() 中已注册的工具名。";
}

export function formatUnknownToolReason(toolName: string, availableToolNames: readonly string[]): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList = preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint = toolName === "mcp"
    ? ""
    : " 若本意是调用 MCP 服务器工具，请在可用时调用已注册的 'mcp' 工具（例如：{\"tool\":\"server:tool\"}）。";

  return `工具 '${toolName}' 未在此运行环境中注册，已在权限检查前被拦截。${mcpHint}已注册工具：${availableList}。`;
}

function formatPermissionHardStopHint(result: PermissionCheckResult): string {
  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    return "硬性拦截：此 MCP 权限拒绝由策略强制执行。不要重试该目标，不要尝试发现/绕过，并向用户报告此拦截。";
  }

  return "硬性拦截：此权限拒绝由策略强制执行。不要重试或尝试绕过，并向用户报告此拦截。";
}

export function formatDenyReason(result: PermissionCheckResult, agentName?: string): string {
  const parts: string[] = [];

  if (agentName) {
    parts.push(`Agent '${agentName}'`);
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    parts.push(`未被允许运行 MCP 目标 '${result.target}'`);
  } else {
    parts.push(`未被允许运行 '${result.toolName}'`);
  }

  if (result.command) {
    parts.push(`命令 '${result.command}'`);
  }

  const deniedUnit = result.bashChecks?.find((check) => check.state === "deny");
  if (deniedUnit && deniedUnit.command !== result.command) {
    parts.push(`因为单元 '${deniedUnit.command}' 已被拒绝`);
  }

  if (result.matchedPattern) {
    parts.push(`(匹配 '${result.matchedPattern}')`);
  }

  return `${parts.join(" ")}。 ${formatPermissionHardStopHint(result)}`;
}

export function formatUserDeniedReason(result: PermissionCheckResult, denialReason?: string): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `用户拒绝了 MCP 目标 '${result.target}'。`
    : result.toolName === "bash" && result.command
      ? `用户拒绝了 bash 命令 '${result.command}'。`
      : `用户拒绝了工具 '${result.toolName}'。`;
  const reasonSuffix = denialReason ? ` 原因：${denialReason}。` : "";

  return `${base}${reasonSuffix} ${formatPermissionHardStopHint(result)}`;
}

function truncateInlineText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function sanitizeInlineText(value: string, maxLength = TOOL_TEXT_SUMMARY_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? truncateInlineText(normalized, maxLength) : "empty text";
}

function countTextLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split(/\r\n|\r|\n/).length;
}

function formatCount(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getPromptPath(input: Record<string, unknown>): string | null {
  return getNonEmptyString(input.path) ?? getNonEmptyString(input.file_path);
}

function countEditPayloadLines(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === "string").length;
  }
  if (typeof value === "string") {
    return countTextLines(value.endsWith("\n") ? value.slice(0, -1) : value);
  }
  return 0;
}

function formatEditReference(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? sanitizeInlineText(value, 40)
    : "锚点";
}

function formatEditReferenceRange(edit: Record<string, unknown>): string {
  const start = formatEditReference(edit.pos);
  const end = typeof edit.end === "string" && edit.end.trim()
    ? ` 到 ${formatEditReference(edit.end)}`
    : "";
  return `${start}${end}`;
}

function formatStructuredEditSummary(edit: Record<string, unknown>, index: number): string | null {
  const ordinal = `编辑 #${index + 1}`;
  const op = typeof edit.op === "string" ? edit.op : "replace_text";

  if (typeof edit.oldText === "string" && typeof edit.newText === "string" && op === "replace_text") {
    return `${ordinal} 用 ${formatCount(countTextLines(edit.oldText), "行", "行")} 替换 ${formatCount(countTextLines(edit.newText), "行", "行")}`;
  }

  const lineCount = formatCount(countEditPayloadLines(edit.lines), "行", "行");
  switch (op) {
    case "replace": {
      const refRange = formatEditReferenceRange(edit);
      return `${ordinal} 在 ${refRange} 替换 ${lineCount}`;
    }
    case "append":
      return `${ordinal} 追加 ${lineCount}${typeof edit.pos === "string" ? ` 于 ${formatEditReference(edit.pos)} 之后` : " 于文件末尾"}`;
    case "prepend":
      return `${ordinal} 插入 ${lineCount}${typeof edit.pos === "string" ? ` 于 ${formatEditReference(edit.pos)} 之前` : " 于文件开头"}`;
    case "delete": {
      const refRange = formatEditReferenceRange(edit);
      return `${ordinal} 在 ${refRange} 删除`;
    }
    default:
      return null;
  }
}

function formatStructuredEditInputForPrompt(input: Record<string, unknown>, fallback?: string): string | null {
  const path = getPromptPath(input);
  const editSummaries = getStructuredEditPayloads(input)
    .map((edit, index) => formatStructuredEditSummary(toRecord(edit), index))
    .filter((summary): summary is string => typeof summary === "string" && summary.length > 0);

  const pathPart = path ? `针对 '${path}'` : "";
  if (editSummaries.length === 0) {
    if (!fallback) {
      return null;
    }
    return pathPart ? `${pathPart} ${fallback}` : fallback;
  }

  const extraEdits = editSummaries.length > 1 ? `，另有 ${formatCount(editSummaries.length - 1, "个编辑", "个编辑")}` : "";
  const summary = `(${formatCount(editSummaries.length, "个编辑", "个编辑")}：${editSummaries[0]}${extraEdits})`;
  return pathPart ? `${pathPart} ${summary}` : summary;
}

function formatEditInputForPrompt(input: Record<string, unknown>): string {
  return formatStructuredEditInputForPrompt(input, "带编辑输入") ?? "带编辑输入";
}

function formatWriteInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const content = typeof input.content === "string" ? input.content : "";
  const summary = `(${formatCount(countTextLines(content), "行", "行")}，${formatCount(content.length, "个字符", "个字符")})`;
  return path ? `针对 '${path}' ${summary}` : summary;
}

function formatReadInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const parts = path ? [`路径 '${path}'`] : [];
  if (typeof input.offset === "number") {
    parts.push(`offset ${input.offset}`);
  }
  if (typeof input.limit === "number") {
    parts.push(`limit ${input.limit}`);
  }
  return parts.length > 0 ? `针对 ${parts.join("，")}` : "";
}

function formatSearchInputForPrompt(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = getPromptPath(input);
  const pattern = getNonEmptyString(input.pattern);
  const glob = getNonEmptyString(input.glob);

  if (pattern) {
    parts.push(`pattern '${sanitizeInlineText(pattern)}'`);
  }
  if (glob) {
    parts.push(`glob '${sanitizeInlineText(glob)}'`);
  }
  if (path) {
    parts.push(`路径 '${path}'`);
  } else if (toolName === "find" || toolName === "grep" || toolName === "ls") {
    parts.push("当前工作目录");
  }

  return parts.length > 0 ? `针对 ${parts.join("，")}` : "";
}

function serializeToolInputPreview(input: unknown): string {
  const serialized = safeJsonStringify(input);
  if (!serialized || serialized === "{}" || serialized === "null") {
    return "";
  }

  return serialized.replace(/\s+/g, " ").trim();
}

function formatJsonInputForPrompt(input: unknown): string {
  const inline = serializeToolInputPreview(input);
  return inline ? `带输入 ${truncateInlineText(inline, TOOL_INPUT_PREVIEW_MAX_LENGTH)}` : "";
}

export function formatToolInputForPrompt(toolName: string, input: unknown): string {
  const inputRecord = toRecord(input);

  switch (toolName) {
    case "edit":
      return formatEditInputForPrompt(inputRecord);
    case "write":
      return formatWriteInputForPrompt(inputRecord);
    case "read":
      return formatReadInputForPrompt(inputRecord);
    case "find":
    case "grep":
    case "ls":
      return formatSearchInputForPrompt(toolName, inputRecord);
    default: {
      const structuredEditPreview = formatStructuredEditInputForPrompt(inputRecord);
      return structuredEditPreview ?? formatJsonInputForPrompt(input);
    }
  }
}

export function formatAgentSubject(agentName?: string): string {
  return agentName ? `Agent '${agentName}'` : "当前 Agent";
}

export function formatAskPrompt(result: PermissionCheckResult, agentName?: string, input?: unknown): string {
  const subject = formatAgentSubject(agentName);

  if (result.toolName === "bash") {
    const askedUnits = result.bashChecks?.filter((check) => check.state === "ask") ?? [];
    const unitInfo = askedUnits.length > 0
      ? ` 需要审批的命令：${askedUnits.map((check) => `'${check.command}'`).join("，")}。`
      : "";
    const patternInfo = result.matchedPattern ? ` (匹配 '${result.matchedPattern}')` : "";
    return `${subject} 请求执行 bash 命令 '${result.command || ""}'${patternInfo}。${unitInfo} 允许此命令？`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern ? ` (匹配 '${result.matchedPattern}')` : "";
    return `${subject} 请求调用 MCP 目标 '${result.target}'${patternInfo}。允许此调用？`;
  }

  const patternInfo = result.matchedPattern ? ` (匹配 '${result.matchedPattern}')` : "";
  const inputPreview = formatToolInputForPrompt(result.toolName, input);
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} 请求调用工具 '${result.toolName}'${patternInfo}${inputSuffix}。允许此调用？`;
}

export function formatSkillAskPrompt(skillName: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} 请求加载 skill '${skillName}'。允许加载此 skill？`;
}

export function formatSkillPathAskPrompt(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} 请求通过 '${readPath}' 访问 skill '${skill.name}'。允许此读取？`;
}

export function formatSkillPathDenyReason(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} 未被允许访问此 skill。`;
}

export function formatExternalDirectoryHardStopHint(): string {
  return "硬性拦截：此外部目录权限拒绝由策略强制执行。不要重试该路径，不要尝试文件系统绕过，并向用户报告此拦截。";
}

export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  return `${formatAgentSubject(agentName)} 请求在工作目录 '${cwd}' 之外对路径 '${pathValue}' 调用工具 '${toolName}'。允许此外部目录访问？`;
}

export function formatExternalDirectoryDenyReason(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  return `${formatAgentSubject(agentName)} 未被允许在工作目录 '${cwd}' 之外对路径 '${pathValue}' 调用工具 '${toolName}'。${formatExternalDirectoryHardStopHint()}`;
}

export function formatExternalDirectoryUserDeniedReason(
  toolName: string,
  pathValue: string,
  denialReason?: string,
): string {
  const reasonSuffix = denialReason ? ` 原因：${denialReason}。` : "";
  return `用户拒绝了工具 '${toolName}' 对路径 '${pathValue}' 的外部目录访问。${reasonSuffix} ${formatExternalDirectoryHardStopHint()}`;
}
