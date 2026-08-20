/**
 * 微信 CLI 登录命令（DEV411：重新扫码 / 首次登录）
 *
 * 运行：YUANYI_PI_WECHAT_STATE_DIR=~/.pi-dev/.yuanyi-pi/wechat npx tsx scripts/wechat-login.ts
 * 仅完成登录并保存 token（不启动轮询）。
 */
import qrcodeTerminal from "qrcode-terminal";
import { WeChatTransport } from "../src/channel/wechat/index";

const stateDir = process.env.YUANYI_PI_WECHAT_STATE_DIR ?? `${process.env.HOME}/.pi-dev/.yuanyi-pi/wechat`;

const transport = new WeChatTransport(
  {
    stateDir,
    pollTimeout: 35,
    qrLogin: {
      force: true,
      onQrCode: (url) => {
        console.log("\n=== 请用手机微信扫码登录 ===\n");
        qrcodeTerminal.generate(url, { small: true });
        console.log(`\n二维码链接: ${url}\n`);
      },
      onVerifyCode: async (prompt) =>
        await new Promise<string>((resolve) => {
          process.stdout.write(prompt);
          process.stdin.once("data", (d) => resolve(String(d).trim()));
        }),
    },
  },
  { onMessage: async () => {} },
);

try {
  await transport.start();
  console.log("✅ 微信登录成功，token 已保存到", stateDir);
  await transport.stop();
  process.exit(0);
} catch (err) {
  console.error("❌ 登录失败:", err instanceof Error ? err.message : err);
  process.exit(1);
}
