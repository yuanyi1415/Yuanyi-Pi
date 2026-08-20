/**
 * 微信消息样式与返回格式单元测试（对照 nanobot sanitize/split/parse 行为）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseItemListToContent,
  sanitizeWeixinMarkdown,
  splitWeixinMessage,
} from "../src/channel/wechat/format";
import { ITEM_FILE, ITEM_IMAGE, ITEM_TEXT, ITEM_VOICE } from "../src/channel/wechat/types";

// ---------- sanitizeWeixinMarkdown ----------

test("sanitize: 代码区外的 < > 转全角，代码区保留", () => {
  const input = "比较 a < b 和 c > d\n```\nconst x = a < b;\n```";
  const out = sanitizeWeixinMarkdown(input);
  assert.ok(out.includes("a ＜ b"), "普通文本 < 转全角");
  assert.ok(out.includes("c ＞ d"), "普通文本 > 转全角");
  assert.ok(out.includes("a < b;"), "代码区内 < 保留");
});

test("sanitize: 去 ~~、去 h5/h6、去图片 markdown", () => {
  const out = sanitizeWeixinMarkdown("~~删除线~~\n###### 标题\n![alt](http://x/y.png) 正文");
  assert.ok(!out.includes("~~"), "删除线已去");
  assert.ok(!out.includes("######"), "h6 已去");
  assert.ok(!out.includes("![alt]"), "图片 markdown 已去");
});

// ---------- splitWeixinMessage ----------

test("split: 短消息不拆分", () => {
  assert.deepEqual(splitWeixinMessage("你好"), ["你好"]);
  assert.deepEqual(splitWeixinMessage(""), []);
});

test("split: 超长消息按边界拆分且合并后不超长", () => {
  const long = "字".repeat(3000);
  const chunks = splitWeixinMessage(long, 1800);
  assert.ok(chunks.length >= 2, "拆成多段");
  for (const c of chunks) assert.ok(c.length <= 1800 + 8, `段长 ${c.length} 不超上限`);
  assert.equal(chunks.join(""), long, "内容不丢失");
});

test("split: 代码块在跨段时保持平衡（下一段补开 ```）", () => {
  const code = "```\n" + "line\n".repeat(500) + "```";
  const chunks = splitWeixinMessage(code, 1800);
  // 段内 fence 必须平衡（偶数个 ```）
  for (const c of chunks) {
    const toggles = c.split("```").length - 1;
    assert.equal(toggles % 2, 0, `段 fence 平衡: ${toggles}`);
  }
});

// ---------- parseItemListToContent ----------

test("parse: 纯文本", () => {
  const content = parseItemListToContent([
    { type: ITEM_TEXT, text_item: { text: "你好世界" } },
  ]);
  assert.equal(content, "你好世界");
});

test("parse: 引用消息格式 [引用: title | text]", () => {
  const content = parseItemListToContent([
    {
      type: ITEM_TEXT,
      text_item: { text: "回复内容" },
      ref_msg: { title: "引用标题", message_item: { type: ITEM_TEXT, text_item: { text: "原文" } } },
    },
  ]);
  assert.equal(content, "[引用: 引用标题 | 原文]\n回复内容");
});

test("parse: 引用媒体时只保留文本（不拼引用前缀）", () => {
  const content = parseItemListToContent([
    {
      type: ITEM_TEXT,
      text_item: { text: "这是对图片的回复" },
      ref_msg: { message_item: { type: ITEM_IMAGE } },
    },
  ]);
  assert.equal(content, "这是对图片的回复");
});

test("parse: 媒体占位格式（一期不下载实体）", () => {
  const content = parseItemListToContent([
    { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "x" } } },
    { type: ITEM_VOICE, voice_item: { text: "语音转写内容" } },
    { type: ITEM_FILE, file_item: { file_name: "报告.pdf" } },
  ]);
  assert.equal(content, "[image]\n[voice] 语音转写内容\n[file: 报告.pdf]");
});

test("parse: 空 item_list → 空内容", () => {
  assert.equal(parseItemListToContent([]), "");
});
