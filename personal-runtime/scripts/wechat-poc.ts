/**
 * 微信 Transport 真实收发验证（POC411）
 *
 * 流程：
 * 1. 终端显示二维码 → 手机微信扫码确认（第一次需输验证码则输入）
 * 2. 登录后开始长轮询
 * 3. 手机微信给被绑定账号发消息 → 终端打印收到的消息（含格式）
 * 4. Transport 自动 echo 回复 → 手机确认收到
 *
 * 运行：YUANYI_PI_WECHAT_STATE_DIR=~/.pi-dev/.yuanyi-pi/wechat npx tsx scripts/wechat-poc.ts
 */
import qrcodeTerminal from "qrcode-terminal";
import { WeChatTransport } from "../src/channel/wechat/index";

const stateDir = process.env.YUANYI_PI_WECHAT_STATE_DIR ?? `${process.env.HOME}/.yuanyi-pi/wechat`;

function printQr(url: string): void {
  console.log("\n=== 请用手机微信扫码登录 ===\n");
  qrcodeTerminal.generate(url, { small: true });
  console.log(`\n若二维码无法显示，请打开: ${url}\n`);
}

const transport = new WeChatTransport(
  {
    stateDir,
    pollTimeout: 35,
    qrLogin: {
      onQrCode: printQr,
      onVerifyCode: async (prompt) => {
        // eslint-disable-next-line no-console
        return await new Promise<string>((resolve) => {
          process.stdout.write(prompt);
          process.stdin.once("data", (d) => resolve(String(d).trim()));
        });
      },
    },
  },
  {
    onMessage: async (msg) => {
      console.log("\n[收到消息] from=%s msgId=%s", msg.contactId, msg.messageId);
      console.log("内容:", JSON.stringify(msg.text));
      console.log("→ 自动回复 echo...");
      await transport.send(msg.contactId, `[自动回复] 已收到: ${msg.text.slice(0, 100)}`);
      console.log("→ 回复已发送\n");
    },
    onAuthExpired: () => {
      console.error("\n⚠️ token 失效，需重新扫码登录");
      process.exit(1);
    },
  },
);

console.log("微信 PoC 启动，stateDir =", stateDir);
transport.start().then(
  () => {
    console.log("✅ 微信已登录并开始长轮询接收。现在用手机微信给该账号发一条消息测试。");
    console.log("（Ctrl+C 退出）");
  },
  (err) => {
    console.error("❌ 启动失败:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

process.on("SIGINT", async () => {
  await transport.stop();
  process.exit(0);
});
