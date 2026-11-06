// 端到端：起一个真服务（隔离端口/数据目录）+ 假 NapCat，模拟主人在私聊里问一个村里的事，
// 看它会不会真的去搜、搜完能不能答对。
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 3813, BOT = 3913;
const DIR = join(tmpdir(), "zk-websearch-" + Date.now());
await mkdir(DIR, { recursive: true });

const real = JSON.parse(await readFile("data/config.json", "utf8"));
await writeFile(join(DIR, "config.json"), JSON.stringify({
  webhook: { enabled: false },
  llm: real.llm,
  clipboard: { enabled: false, autoAdd: false, onlyFromQQ: true },
  qq: { enabled: true, api: `http://127.0.0.1:${BOT}`, token: "", owner: "10001", bot: "10002", groups: [], groupMode: "chatty", botAlias: ["小助手"] },
  notifyDesktop: false
}, null, 2), "utf8");

const got = [];
const bot = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const j = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
    const url = req.url.split("?")[0];
    res.setHeader("content-type", "application/json");
    if (url.includes("send_private_msg") || url.includes("send_msg")) {
      const text = (j.message || []).filter(s => s.type === "text").map(s => s.data.text).join("");
      got.push(text);
      return res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
    }
    if (url.includes("login_info")) return res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 10002, nickname: "小助手" } }));
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] } }));
  });
});
await new Promise(r => bot.listen(BOT, "127.0.0.1", r));

const srv = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: DIR, TODO_NO_OPEN: "1", TODO_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
srv.stdout.on("data", d => process.stdout.write("[srv] " + d));
srv.stderr.on("data", d => process.stdout.write("[srv!] " + d));

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/qq-catchup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1500) }); return true; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  return false;
}
if (!await waitPort()) { console.log("服务没起来"); srv.kill(); bot.close(); process.exit(1); }
await new Promise(r => setTimeout(r, 1500)); // 让启动补处理先跑完

const q = "示例县的示例村知道吗，具体在哪个街道，邮编多少";
await fetch(`http://127.0.0.1:${PORT}/api/onebot`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ post_type: "message", message_type: "private", user_id: 10001, message_id: 88881, time: Math.floor(Date.now() / 1000), message: [{ type: "text", data: { text: q } }] })
});

console.log("\n问：", q);
for (let i = 0; i < 120 && !got.length; i++) await new Promise(r => setTimeout(r, 1000));
console.log("\n答：", got[0] || "（没有回复）");

// 日志里应当出现 web_search / fetch_url 的调用记录
const log = await readFile(join(DIR, "logs", new Date().toLocaleDateString("sv-SE") + ".log"), "utf8").catch(() => "");
const tools = [...log.matchAll(/助手 → (\w+) (\{.*?\})\s*$/gm)].map(m => m[1] + " " + m[2].slice(0, 70));
console.log("\n工具调用顺序：");
tools.forEach(t => console.log("  -", t));
console.log("\n结论：", tools.some(t => t.startsWith("web_search")) ? "会主动搜索 ✅" : "没搜索 ❌");

srv.kill(); bot.close(); await rm(DIR, { recursive: true, force: true }).catch(() => {});
process.exit(0);
