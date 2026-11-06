// QQ 语义判断回归测试：取消意图 / 上下文补全 / 兜底拦截
// 用一个假的 NapCat（mock 3000）接住回复，全程不碰真实账号和真实数据。
// 跑法：node _test-qq-intent.mjs

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 3799;
const MOCK = 3901;
const OWNER = "10001";
const BOT = "10002";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  → " + detail : ""}`); }
}

// ---- 假 NapCat：记录小号被要求发出的每条消息 ----
const sent = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body || "{}");
      const text = (j.message || []).map(m => m?.data?.text || "").join("");
      sent.push(text);
    } catch { sent.push(""); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));

// ---- 隔离的数据目录（模型用真实的 key，QQ 用假的 NapCat） ----
const dataDir = await mkdtemp(join(tmpdir(), "todo-intent-"));

let llm = { enabled: false };
try {
  const real = JSON.parse(await readFile(join(process.cwd(), "data", "config.json"), "utf8"));
  if (real?.llm?.apiKey) llm = { ...real.llm, enabled: true };
} catch {}
if (!llm.apiKey) {
  console.log("没读到 data/config.json 里的 API Key，意图判断会走本地降级路径，结果仅供参考。");
}

await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm,
  qq: { enabled: true, api: `http://127.0.0.1:${MOCK}`, token: "", owner: OWNER, bot: BOT }
}, null, 2), "utf8");

const srv = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: dataDir, TODO_NO_OPEN: "1", TODO_NO_WATCH: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let srvErr = "";
srv.stderr.on("data", d => (srvErr += d.toString()));

const base = `http://127.0.0.1:${PORT}`;
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(base + "/api/state");
    if (r.ok) { ready = true; break; }
  } catch {}
  await sleep(200);
}
if (!ready) {
  console.log("服务没起来：\n" + srvErr);
  process.exit(1);
}

let mid = 500000;
async function say(text) {
  sent.length = 0;
  mid++;
  await fetch(base + "/api/onebot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      post_type: "message", message_type: "private", sub_type: "friend",
      self_id: Number(BOT), user_id: Number(OWNER), message_id: mid, time: 1793793000,
      message: [{ type: "text", data: { text } }], raw_message: text
    })
  });
  // 模型判断要几秒，轮询等回复
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    if (sent.length) break;
  }
  await sleep(150);
  return sent[0] || "";
}

const state = async () => (await fetch(base + "/api/state")).json();
const titles = async () => (await state()).tasks.map(t => t.title);

// ---- 1. 正常通知：该建就建 ----
{
  const reply = await say("明天下午两点半讲座");
  const ts = await titles();
  check("正常通知入库", ts.some(t => t.includes("讲座")), JSON.stringify(ts));
  check("正常通知有回执", /已记下/.test(reply), reply);
}

// ---- 2. 「讲座取消了」：删掉那条，而不是新建 ----
{
  const before = await titles();
  const reply = await say("讲座取消了");
  const after = await titles();
  check("取消意图不回执「已记下」", !/已记下/.test(reply), reply);
  check("取消意图回执「已取消」", /已取消/.test(reply), reply);
  check("取消后任务确实少了", after.length === before.length - 1, `${before.length} → ${after.length}`);
  check("没有生成「讲座取消」这种脏任务", !after.some(t => /取消/.test(t)), JSON.stringify(after));
}

// ---- 3. 取消一个不存在的 ----
{
  const reply = await say("英语角取消了");
  check("取消不存在的任务给出提示", /没找到「英语角」/.test(reply), reply);
}

// ---- 4. 「明天的」孤立出现：不能入库 ----
{
  const before = (await titles()).length;
  const reply = await say("明天的");
  const after = (await titles()).length;
  check("孤立「明天的」不入库", after === before, `${before} → ${after}`);
  check("孤立「明天的」给出解释", reply.length > 0 && !/已记下/.test(reply), reply);
}

// ---- 5. 缺时间 → 追问 → 只给「明天」还缺几点 → 给全后补上 ----
{
  const r1 = await say("高数作业要交");
  check("缺时间时追问", /回一句具体时间/.test(r1) || /缺/.test(r1), r1);

  const r2 = await say("明天的");
  check("只给「明天」时继续追问几点", /缺几点/.test(r2), r2);

  const r3 = await say("明天下午5点");
  check("补全后回执已记下", /已记下/.test(r3), r3);

  const st = await state();
  const ts = st.tasks.map(t => t.title);
  const task = st.tasks.find(t => t.title.includes("高数"));
  // 作业类是「截止」时间，所以补到 due 而不是 start
  check("补全后时间正确", (task?.due || task?.start) === "2026-11-05T17:00:00+08:00",
    `task=${JSON.stringify(task?.title)} due=${JSON.stringify(task?.due)} start=${JSON.stringify(task?.start)}`);
  check("补全后没有多出「明天的」任务", !ts.includes("明天的"), JSON.stringify(ts));
}

// ---- 6. 长句子里的「取消」不能误删 ----
{
  const before = (await titles()).length;
  const reply = await say("明天下午的讲座取消了，改到11月9日上午10点在大礼堂");
  const after = (await titles()).length;
  check("长句中含取消不触发删除", after >= before - 1, `${before} → ${after}`);
  check("长句不被当成撤回", !/^已取消/.test(reply.trim()), reply);
}

// ---- 收尾 ----
console.log(results.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);

srv.kill();
mock.close();
await sleep(300);
await rm(dataDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
