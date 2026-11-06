// 复现并验证「握手卡死」这个真实故障：
// NapCat 容器刚起、QQ 还没登录时，它的 WS 服务没开，但 docker-proxy 已经把 TCP 接了下来，
// 于是 WebSocket 既不 open 也不 close，永远挂着 —— 云端服务就这样一条消息都收不到。
//
// 这里用一个「只接 TCP、永远不回 101」的服务器重现它，看客户端会不会超时断开重来。
import net from "node:net";
import { startOneBotWs } from "./src/onebot-ws.mjs";

let conns = 0;
const srv = net.createServer(sock => {
  conns++;
  sock.on("data", () => { /* 收到了握手请求，就是不回 */ });
  sock.on("error", () => {});
});
await new Promise(r => srv.listen(3957, "127.0.0.1", r));

const logs = [];
const ws = startOneBotWs({
  url: "ws://127.0.0.1:3957",
  log: (...a) => logs.push(a.join(" ")),
  onEvent: () => {},
  handshakeMs: 1000
});

await new Promise(r => setTimeout(r, 8200));

const timeouts = logs.filter(l => l.includes("握手"));
const connected = logs.filter(l => l.includes("已连上"));

console.log(logs.join("\n") || "(没有日志)");
console.log("");

const checks = [
  ["承认握手超时（不是干等）", timeouts.length >= 2],
  ["超时后重新发起连接", conns >= 2],
  ["没有误报「已连上」", connected.length === 0],
  ["每次超时只排一次重连（没有翻倍刷屏）", timeouts.length <= conns]
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(ok ? "✅" : "❌", name);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过　（node ${process.version}，建立连接 ${conns} 次）`);

ws.stop();
srv.close();
process.exit(pass === checks.length ? 0 : 1);
