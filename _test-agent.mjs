// QQ 模型助手端到端测试：模型当大脑 + 待办工具
// 用真实的 DeepSeek key，NapCat 用假的，数据目录隔离，不碰真实账号。
// 跑法：node _test-agent.mjs

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 3802;
const MOCK = 3903;
const OWNER = "10001";
const BOT = "10002";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  → " + detail : ""}`); }
};

const sent = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = String(req.url || "").replace(/^\//, "");
    res.setHeader("content-type", "application/json");
    if (action === "get_friend_msg_history") {
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] } }));
      return;
    }
    try {
      const j = JSON.parse(body || "{}");
      sent.push((j.message || []).map(m => m?.data?.text || "").join(""));
    } catch { sent.push(""); }
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));

let llm = { enabled: false };
try {
  const real = JSON.parse(await readFile(join(process.cwd(), "data", "config.json"), "utf8"));
  if (real?.llm?.apiKey) llm = { ...real.llm, enabled: true };
} catch {}
if (!llm.apiKey) {
  console.log("没读到 data/config.json 里的 API Key，测不了。");
  process.exit(1);
}

const dataDir = await mkdtemp(join(tmpdir(), "todo-agent-"));
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm,
  qq: { enabled: true, api: `http://127.0.0.1:${MOCK}`, token: "", owner: OWNER, bot: BOT }
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

let mid = 700001;
async function say(text, waitMs = 90000) {
  sent.length = 0;
  await fetch(`http://127.0.0.1:${PORT}/api/onebot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      post_type: "message", message_type: "private", sub_type: "friend",
      self_id: Number(BOT), user_id: Number(OWNER),
      message_id: ++mid, time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text } }], raw_message: text,
      sender: { user_id: Number(OWNER), nickname: "主人" }
    })
  });
  // 上报接口是立刻返回的，模型回话要等一会儿，轮询等它发出来
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(400);
    if (sent.filter(Boolean).length) break;
  }
  await sleep(500);
  return sent.filter(Boolean).join("\n");
}

try {
  await sleep(5000);

  // 1. 正常记一条
  const r1 = await say("明天下午两点在三教201开会");
  const s1 = await state();
  check("记下了会议", s1.tasks.length === 1, JSON.stringify(s1.tasks.map(t => t.title)));
  check("模型回了话", r1.length > 0, r1);
  check("没出现机器腔", !/已记录至待办列表|已成功添加/.test(r1), r1);
  console.log("  [回复1]", r1.replace(/\n/g, " / "));

  // 2. 查列表
  const r2 = await say("我现在有什么待办");
  check("查列表答得出来", /开会|会议/.test(r2), r2);
  console.log("  [回复2]", r2.replace(/\n/g, " / "));

  // 3. 截图里翻车的那句：全部删除
  const r3 = await say("删除现有所有的待办");
  const s3 = await state();
  check("「全部删除」真的删光了", s3.tasks.length === 0, `剩 ${s3.tasks.length} 条：${JSON.stringify(s3.tasks.map(t => t.title))}`);
  console.log("  [回复3]", r3.replace(/\n/g, " / "));

  // 4. 补时间（截图里「11.9」那种）
  await say("高数作业要交");
  const r4 = await say("11月9日早上八点");
  const s4 = await state();
  const hw = (s4.tasks || []).find(t => /高数|作业/.test(t.title));
  check("补时间没多出新任务", (s4.tasks || []).length === 1, JSON.stringify((s4.tasks || []).map(t => t.title)));
  check("补上了 11/9 08:00", Boolean(hw) && /2026-11-09T08:00/.test(String(hw.due || hw.start || "")),
    JSON.stringify(hw && { due: hw.due, start: hw.start }));
  console.log("  [回复4]", r4.replace(/\n/g, " / "));
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
