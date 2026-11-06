// 私聊发图回归：截图直接交给模型看，看它会不会把图里的通知记成待办。
// 真实 DeepSeek + 假 NapCat + 隔离数据目录。
// 跑法：node _test-private-img.mjs
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 3805;
const MOCK = 3906;
const OWNER = "20001";
const BOT = "20002";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  → " + detail : ""}`); }
};

const imgBuf = await readFile(join(process.cwd(), "_test-group-img.png"));
const sent = [];
const mock = http.createServer((req, res) => {
  if (String(req.url || "").startsWith("/img/")) {
    res.setHeader("content-type", "image/png");
    res.end(imgBuf);
    return;
  }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = String(req.url || "").replace(/^\//, "");
    res.setHeader("content-type", "application/json");
    if (action === "get_friend_msg_history") {
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] } }));
      return;
    }
    let text = "";
    let j = {};
    try { j = JSON.parse(body || "{}"); text = (j.message || []).map(m => m?.data?.text || "").join(""); } catch {}
    sent.push({ action, text });
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));

let llm = { enabled: false };
try {
  const real = JSON.parse(await readFile(join(process.cwd(), "data", "config.json"), "utf8"));
  if (real?.llm?.apiKey) llm = { ...real.llm, enabled: true };
} catch {}
if (!llm.apiKey) { console.log("没读到 API Key，测不了。"); process.exit(1); }

const dataDir = await mkdtemp(join(tmpdir(), "todo-pimg-"));
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm,
  qq: { enabled: true, api: `http://127.0.0.1:${MOCK}`, token: "", owner: OWNER, bot: BOT, groups: [] }
}, null, 2), "utf8");

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: dataDir, TODO_NO_OPEN: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let stdout = "";
child.stdout.on("data", d => (stdout += d.toString()));
child.stderr.on("data", d => (stdout += d.toString()));

const state = () => fetch(`http://127.0.0.1:${PORT}/api/state`).then(r => r.json());
let mid = 900001;

function event({ text = "", image = false }) {
  const segs = [];
  if (text) segs.push({ type: "text", data: { text } });
  if (image) segs.push({ type: "image", data: { file: "test.png", url: `http://127.0.0.1:${MOCK}/img/test.png` } });
  return {
    post_type: "message", message_type: "private", sub_type: "friend",
    self_id: Number(BOT), user_id: Number(OWNER), message_id: ++mid,
    time: Math.floor(Date.now() / 1000), message: segs,
    raw_message: text + (image ? "[CQ:image,file=test.png]" : ""),
    sender: { user_id: Number(OWNER), nickname: "主人" }
  };
}

async function push(ev, waitMs = 90000) {
  const before = sent.length;
  await fetch(`http://127.0.0.1:${PORT}/api/onebot`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev)
  });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(400);
    if (sent.slice(before).some(s => s.action === "send_private_msg")) break;
  }
  await sleep(600);
  return sent.slice(before).filter(s => s.action === "send_private_msg").map(s => s.text).join("\n");
}

try {
  await sleep(5000);

  // 1. 只发图，一个字都不打 → 它得看懂并记成待办
  const r1 = await push(event({ image: true }));
  const s1 = await state();
  const t1 = (s1.tasks || [])[0];
  check("只发截图也能回话", Boolean(r1), JSON.stringify(r1));
  check("截图里的通知被记成待办", Boolean(t1) && /作业/.test(t1.title), JSON.stringify((s1.tasks || []).map(t => t.title)));
  check("待办时间落在周五 22:00", /2026-11-06T22:00/.test(String(t1?.due || t1?.start)), JSON.stringify({ start: t1?.start, due: t1?.due }));
  check("没说自己看不见图", !/看不见|看不到|加载不|空白|刷不出/.test(r1), r1);
  if (r1) console.log("  [私聊-图]", r1.replace(/\n/g, " / ").slice(0, 200));

  // 2. 图 + 一句话 → 照常处理
  const r2 = await push(event({ text: "这个记一下", image: true }));
  check("图加文字也认", Boolean(r2), JSON.stringify(r2));
} catch (err) {
  check("测试过程没抛异常", false, err.message);
} finally {
  child.kill();
  await sleep(800);
  mock.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) console.log("\n--- 服务输出 ---\n" + stdout.slice(-3000));
process.exit(fail ? 1 : 0);
