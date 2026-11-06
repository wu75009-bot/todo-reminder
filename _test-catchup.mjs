// 补处理回归测试：验证「服务停机期间 NapCat 丢掉的私聊」能被启动时补回来。
// 用假 NapCat 提供历史消息，隔离数据目录，不碰真实账号和真实数据。
// 跑法：node _test-catchup.mjs

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 3801;
const MOCK = 3902;
const OWNER = "10001";
const BOT = "10002";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  → " + detail : ""}`); }
}

const now = Math.floor(Date.now() / 1000);

// 三条历史：两条主人发的（要补），一条小号自己回的（必须跳过）
const history = [
  { time: now - 70, message_id: 1, user_id: OWNER, sender: { user_id: Number(OWNER) },
    message: [{ type: "text", data: { text: "明天下午两点开会" } }] },
  { time: now - 65, message_id: 2, user_id: BOT, sender: { user_id: Number(BOT) },
    message: [{ type: "text", data: { text: "已记下：会议" } }] },
  { time: now - 60, message_id: 3, user_id: OWNER, sender: { user_id: Number(OWNER) },
    message: [{ type: "text", data: { text: "明天下午三点考试，三教201" } }] }
];

let historyCalls = 0;
const sent = [];

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = String(req.url || "").replace(/^\//, "");
    res.setHeader("content-type", "application/json");
    if (action === "get_friend_msg_history") {
      historyCalls++;
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { messages: history } }));
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

// ---- 隔离数据目录：水位卡在三条历史之前 ----
const dataDir = await mkdtemp(join(tmpdir(), "todo-catchup-"));
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm: { enabled: false, mode: "fallback", imageMode: "local", apiKey: "" },
  qq: { enabled: true, api: `http://127.0.0.1:${MOCK}`, token: "", owner: OWNER, bot: BOT }
}, null, 2), "utf8");
await writeFile(join(dataDir, "qq-last.json"), JSON.stringify({ lastTime: now - 120 }), "utf8");

// ---- 起一个隔离的服务实例 ----
const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: dataDir, TODO_NO_OPEN: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let stdout = "";
child.stdout.on("data", d => (stdout += d.toString()));
child.stderr.on("data", d => (stdout += d.toString()));

async function state() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
  return res.json();
}

try {
  // 补处理是启动后 8 秒触发的
  await sleep(16000);
  const st = await state();
  const tasks = st.tasks || [];
  const titles = tasks.map(t => t.title);

  check("确实调了拉历史接口", historyCalls >= 1, `calls=${historyCalls}`);
  check("补出了任务", tasks.length >= 1, JSON.stringify(titles));
  check("开会那条补上了", titles.some(t => /开会|会议/.test(t)), JSON.stringify(titles));
  check("考试那条补上了", titles.some(t => /考试/.test(t)), JSON.stringify(titles));
  check("没把小号自己的回复当通知", !titles.some(t => /已记下/.test(t)), JSON.stringify(titles));
  check("给主人发了补处理汇总", sent.some(s => /补处理了/.test(s)), JSON.stringify(sent));

  const last = JSON.parse(await readFile(join(dataDir, "qq-last.json"), "utf8"));
  check("水位推进到启动时刻", Number(last.lastTime) >= now - 5, JSON.stringify(last));
  check("水位没越过启动时刻太多", Number(last.lastTime) <= Math.floor(Date.now() / 1000) + 2, JSON.stringify(last));

  // 再启一次：这次水位已经在历史之后，应该一条都不补
  sent.length = 0;
  historyCalls = 0;
} catch (err) {
  check("测试过程没抛异常", false, err.message);
} finally {
  child.kill();
  await sleep(600);
  mock.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(results.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("\n--- 服务输出 ---\n" + stdout.slice(-2500));
  process.exit(1);
}
