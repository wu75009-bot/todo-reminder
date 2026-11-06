// 用最小 WebSocket 服务端验证 WS 事件通道：握手、收事件、断线重连
import http from "node:http";
import { createHash } from "node:crypto";
import { startOneBotWs } from "./src/onebot-ws.mjs";

const ACCEPT = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
  const body = Buffer.from(text, "utf8");
  const head = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
}

let sockets = [];
const srv = http.createServer((q, s) => s.end("ok"));
srv.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + ACCEPT).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  sockets.push(socket);
  // 先发一条非消息事件（应被忽略），再发一条私聊消息
  setTimeout(() => socket.write(frame(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }))), 100);
  setTimeout(() => socket.write(frame(JSON.stringify({
    post_type: "message", message_type: "private", user_id: 10001, message_id: 42,
    message: [{ type: "text", data: { text: "第一次" } }]
  }))), 200);
  // 发完就断，考验重连
  setTimeout(() => socket.destroy(), 400);
});

await new Promise(r => srv.listen(3955, "127.0.0.1", r));

const got = [];
const logs = [];
const ws = startOneBotWs({
  url: "ws://127.0.0.1:3955",
  log: (...a) => logs.push(a.join(" ")),
  onEvent: ev => got.push(ev)
});

await new Promise(r => setTimeout(r, 1200));
if (sockets.length) sockets[sockets.length - 1].write(frame(JSON.stringify({
  post_type: "message", message_type: "private", user_id: 10001, message_id: 43,
  message: [{ type: "text", data: { text: "重连之后" } }]
})));
await new Promise(r => setTimeout(r, 4500));

const checks = [
  ["收到 2 条消息事件（重连后还在收）", got.length === 2],
  ["心跳事件被忽略", got.every(e => e.post_type === "message")],
  ["断线后自动重连并发起第二次握手", sockets.length >= 2],
  ["重连日志有输出", logs.some(l => l.includes("重连"))]
];
let pass = 0;
for (const [name, ok] of checks) { console.log(ok ? "✅" : "❌", name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
console.log("日志：", logs.join(" | "));
ws.stop(); sockets.forEach(s => s.destroy()); srv.close();
process.exit(pass === checks.length ? 0 : 1);
