import { createServer } from "node:http";
import QRCode from "qrcode";

const QR_URL = process.argv[2] || "";
const port = 8899;
createServer(async (req, res) => {
  if (req.url === "/qr.png") {
    try {
      const png = await QRCode.toBuffer(QR_URL, { width: 480, margin: 2 });
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>微信登录二维码</title></head>
  <body style="text-align:center;font-family:sans-serif;background:#f5f5f5;padding:30px">
  <h2>请用手机微信扫码登录</h2>
  <img src="/qr.png" style="width:320px;height:320px;border:1px solid #ddd;background:#fff;padding:10px"/>
  <p style="color:#666">扫码后手机确认，此页会自动过期刷新（扫码前请确认此页二维码与终端一致）</p>
  <p style="word-break:break-all;font-size:12px;color:#999"><a href="${QR_URL}">${QR_URL}</a></p>
  </body></html>`);
}).listen(port, "127.0.0.1", () => {
  console.log(`QR page: http://127.0.0.1:${port}`);
  console.log(`QR url: ${QR_URL}`);
});
