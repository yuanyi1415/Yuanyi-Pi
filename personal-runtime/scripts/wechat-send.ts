/**
 * 微信主动发送验证（POC411：主动发送文本，不依赖入站消息触发）
 *
 * 用已保存的 token（account.json）向指定联系人主动发送。
 * 目标：扫码账号的 im id（o9cq80...@im.wechat）。
 *
 * 运行：npx tsx scripts/wechat-send.ts
 */
import { WeChatTransport } from "../src/channel/wechat/index";

const target = process.argv[2] ?? "o9cq80wTHm9OC2BDCnZfDxslJfRQ@im.wechat";
const stateDir = process.env.YUANYI_PI_WECHAT_STATE_DIR ?? `${process.env.HOME}/.pi-dev/.yuanyi-pi/wechat`;

const transport = new WeChatTransport(
  { stateDir, pollTimeout: 35 },
  { onMessage: async () => {} },
);

await transport.start();
console.log("✅ 已用保存的 token 恢复连接（验证 token 复用/重连基础）");
console.log(`→ 主动发送到 ${target} ...`);
await transport.send(target, `主动发送测试-${new Date().toISOString()}`);
console.log("✅ 主动发送完成（程序主动发起，无需对方先发消息）");
await transport.stop();
process.exit(0);
