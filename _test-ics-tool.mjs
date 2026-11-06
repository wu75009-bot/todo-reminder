// 端到端：主人在私聊里说「要ics」，它必须调 send_ics 发文件，而不是吐一段 BEGIN:VCALENDAR 让他自己存。
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 3814, BOT = 3914;
const DIR = join(tmpdir(), "zk-ics-" + Date.now());
await mkdir(DIR, { recursive: true });

const real = JSON.parse(await readFile("data/config.json", "utf8"));
await writeFile(join(DIR, "config.json"), JSON.stringify({
  webhook: { enabled: false },
  llm: real.llm,
  clipboard: { enabled: false, autoAdd: false, onlyFromQQ: true },
  qq: { enabled: true, api: `http://127.0.0.1:${BOT}`, token: "", owner: "10001", bot: "10002", groups: [], groupMode: "chatty", botAlias: ["小助手"] },
  notifyDesktop: false
}, null, 2), "utf8");

const msgs = [], uploaded = [];
const bot = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const j = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
    const url = req.url.split("?")[0];
    res.setHeader("content-type", "application/json");
    if (url.includes("upload_private_file")) {
      uploaded.push(j);
      return res.end(JSON.stringify({ status: "ok", retcode: 0, data: { file_id: "x" } }));
    }
    if (url.includes("send_private_msg") || url.includes("send_msg")) {
      msgs.push((j.message || []).filter(s => s.type === "text").map(s => s.data.text).join(""));
      return res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
    }
    if (url.includes("login_info")) return res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 10002 } }));
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] } }));
  });
});
await new Promise(r => bot.listen(BOT, "127.0.0.1", r));

const srv = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: DIR, TODO_NO_OPEN: "1", TODO_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
srv.stdout.on("data", d => { const s = String(d).trim(); if (s) console.log("[srv]", s); });
srv.stderr.on("data", d => console.log("[srv!]", String(d).trim()));

const api = (p, opt) => fetch(`http://127.0.0.1:${PORT}${p}`, opt);
for (let i = 0; i < 60; i++) {
  try { await api("/api/qq-catchup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1500) }); break; }
  catch { await new Promise(r => setTimeout(r, 500)); }
}
await new Promise(r => setTimeout(r, 1200));

// 先记一条有时有刻的待办，否则没有提醒可导
await api("/api/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "11月15日下午两点半全体成员培训，四点半结束" }) });

const push = text => api("/api/onebot", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ post_type: "message", message_type: "private", user_id: 10001, message_id: Math.floor(Math.random() * 1e6), time: Math.floor(Date.now() / 1000), message: [{ type: "text", data: { text } }] })
});

await push("帮我把待办导成ics发我");
for (let i = 0; i < 90 && !msgs.length; i++) await new Promise(r => setTimeout(r, 1000));

console.log("\n=== 回答 ===\n" + (msgs[0] || "（没有回复）"));
console.log("\n=== 发出去的文件 ===\n" + (uploaded.length ? JSON.stringify(uploaded.map(u => u.name)) : "（没发文件）"));
console.log("\n结论：", uploaded.length ? "直接发了文件 ✅" : "没发文件 ❌");

srv.kill(); bot.close(); await rm(DIR, { recursive: true, force: true }).catch(() => {});
process.exit(0);
