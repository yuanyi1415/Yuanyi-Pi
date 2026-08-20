/**
 * 微信消息样式与返回格式（照抄 nanobot sanitize_weixin_markdown /
 * split_weixin_message / _process_message 的 item_list 解析格式）
 *
 * 一期范围：文本内容 + 媒体占位文本（不下载/上传媒体实体，但 Agent 看到的
 * 返回格式与 nanobot 一致，如 [image]、[file: 名称]、[引用: ...]）。
 */
import {
  ITEM_FILE,
  ITEM_IMAGE,
  ITEM_TEXT,
  ITEM_VIDEO,
  ITEM_VOICE,
  WEIXIN_MAX_MESSAGE_LEN,
  type WeixinItem,
  type WeixinRefMsg,
} from "./types";

/** 是否含可下载媒体定位（nanobot _has_downloadable_media_locator） */
function hasDownloadableMediaLocator(media: Record<string, unknown> | undefined): boolean {
  if (!media || typeof media !== "object") return false;
  return Boolean(
    String(media.encrypt_query_param ?? "") || String(media.full_url ?? "").trim(),
  );
}

/**
 * 清理 markdown（nanobot sanitize_weixin_markdown）
 * - 代码区（``` 与 `）字节保留
 * - 代码区外：去图片 markdown、< > 转全角、去 ~~、去 h5/h6 标题
 */
export function sanitizeWeixinMarkdown(content: string): string {
  if (!content) return content;
  const codePattern = /(```[\s\S]*?```|`[^`\n]*`)/;
  const parts = content.split(codePattern);
  for (let i = 0; i < parts.length; i += 2) {
    let text = parts[i] ?? "";
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    text = text.replace(/</g, "＜").replace(/>/g, "＞");
    text = text.replace(/~~/g, "");
    text = text.replace(/^#{5,6}\s+/gm, "");
    parts[i] = text;
  }
  return parts.join("");
}

/**
 * 按长度拆分消息，平衡 ``` 代码块（nanobot split_weixin_message）
 */
export function splitWeixinMessage(
  content: string,
  maxLen = WEIXIN_MAX_MESSAGE_LEN,
): string[] {
  content = sanitizeWeixinMarkdown(content).trim();
  if (!content) return [];
  if (maxLen <= 0 || content.length <= maxLen) return [content];

  const chunks: string[] = [];
  let remaining = content;
  let inFence = false;
  while (remaining) {
    const prefix = inFence ? "```\n" : "";
    const suffixBudget = 4; // ``\n``` `` 预留
    const available = maxLen - prefix.length - suffixBudget;
    if (available <= 0) return [content];
    let rawPiece: string;
    if (remaining.length <= available) {
      rawPiece = remaining;
    } else {
      const candidate = remaining.slice(0, available);
      let cut = candidate.lastIndexOf("\n\n");
      if (cut <= 0) cut = candidate.lastIndexOf("\n");
      if (cut <= 0) {
        const marks = ["。", "！", "？", "；", ".", "!", "?", ";", " "];
        let punctuation = -1;
        for (const mark of marks) {
          punctuation = Math.max(punctuation, candidate.lastIndexOf(mark));
        }
        cut = punctuation >= 0 ? punctuation + 1 : available;
      }
      rawPiece = candidate.slice(0, cut);
    }
    remaining = remaining.slice(rawPiece.length).replace(/^\s+/, "");
    const toggles = rawPiece.split("```").length - 1;
    let nextInFence: boolean = inFence !== (toggles % 2 === 1);
    let rendered = prefix + rawPiece.trimEnd();
    if (nextInFence) rendered += "\n```";
    chunks.push(rendered);
    inFence = nextInFence;
  }
  return chunks;
}

/**
 * 入站 item_list → 统一文本内容（nanobot _process_message 解析格式）
 *
 * 一期：文本/引用完整照抄；媒体输出占位文本（不下载实体）。
 */
export function parseItemListToContent(itemList: WeixinItem[]): string {
  const contentParts: string[] = [];
  for (const item of itemList ?? []) {
    const type = item.type ?? 0;

    if (type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? "");
      if (!text) continue;
      // 引用消息（inbound.ts:86-98）
      const ref = item.ref_msg as WeixinRefMsg | undefined;
      if (ref) {
        const refItem = ref.message_item;
        // 引用的是媒体 → 只传文本
        if (
          refItem &&
          [ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO].includes(refItem.type ?? 0)
        ) {
          contentParts.push(text);
        } else {
          const parts: string[] = [];
          if (ref.title) parts.push(String(ref.title));
          if (refItem) {
            const refText = String(refItem.text_item?.text ?? "");
            if (refText) parts.push(refText);
          }
          if (parts.length > 0) {
            contentParts.push(`[引用: ${parts.join(" | ")}]\n${text}`);
          } else {
            contentParts.push(text);
          }
        }
      } else {
        contentParts.push(text);
      }
    } else if (type === ITEM_IMAGE) {
      const media = item.image_item?.media as Record<string, unknown> | undefined;
      // 一期不下载媒体实体：有定位标记时仍只给占位（格式与 nanobot 失败分支一致）
      if (hasDownloadableMediaLocator(media)) {
        contentParts.push("[image]");
      } else {
        contentParts.push("[image]");
      }
    } else if (type === ITEM_VOICE) {
      // 微信侧转写文本（voice_item.text）
      const voiceText = String(item.voice_item?.text ?? "");
      if (voiceText) {
        contentParts.push(`[voice] ${voiceText}`);
      } else {
        contentParts.push("[voice]");
      }
    } else if (type === ITEM_FILE) {
      const fileName = String(item.file_item?.file_name ?? "unknown");
      contentParts.push(`[file: ${fileName}]`);
    } else if (type === ITEM_VIDEO) {
      contentParts.push("[video]");
    }
  }
  return contentParts.join("\n");
}

/** 引用/媒体占位解析辅助（保留给后续富媒体扩展） */
export { hasDownloadableMediaLocator };
