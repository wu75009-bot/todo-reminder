// 真实模型下的补漏安全检查。
// 前面那个 _test-catchup-e2e.mjs 用的是规则解析（llm 关掉），线上实际走的是模型路径，
// 所以这里用真实 DeepSeek 跑一遍，确认两件事：
//   1. 老消息里的「删掉吧」在补处理时执行不了（工具集里根本没有 delete_tasks）
//   2. 补处理全程不逐条回消息，只留最后一条汇总
//
// 跑法：node _test-catchup-llm.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "_tc3");
const APP_PORT = 3812;
const FAKE_PORT = 3912;
const OWNER = "10001";
const BOT = "10002";

const now = Math.floor(Date.now() / 1000);

// 真实模型的配置从正式 config 里借，不硬编码 key
const real = JSON.parse(await readFile(join(HERE, "data", "config.json"), "utf8"));
if (!real.llm?.apiKey && !real.llm?.key) {
  console.log("正式配置里没有模型 key，跳过真实模型测试");
  process.exit(0);
}

const msgs = [
  { message_id: "2001", message_seq: "2001", time: now - 20 * 60, sender: { user_id: Number(OWNER) },
    raw_message: "12月5日上午9点要去教务处交材料",
    message: [{ type: "text", data: { text: "12月5日上午9点要去教务处交材料" } }] },
  // 这条是当初真把任务删掉的那一句，现在重放，必须删不掉
  { message_id: "2002", message_seq: "2002", time: now - 19 * 60, sender: { user_id: Number(OWNER) },
    raw_message: "把超时的旧待办都删掉吧", message: [{ type: "text", data: { text: "把超时的旧待办都删掉吧" } }] }
];

const PRESET_ID = "keepme01";
const presetTask = {
  id: PRESET_ID, title: "下周要交的英语作文", type: "作业", typeName: "作业",
  start: null, due: null, end: null, status: "open", notes: [],
  createdAt: new Date().toISOString()
};

let replyCount = 0;
const replies = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = req.url.replace(/^\//, "").split("?")[0];
    const j = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (action === "get_login_info") return j({ status: "ok", retcode: 0, data: { user_id: Number(BOT), nickname: "。" } });
    if (action === "get_friend_msg_history") return j({ status: "ok", retcode: 0, data: { messages: msgs } });
    if (action === "send_private_msg") {
      replyCount++;
      try { replies.push(JSON.parse(body || "{}").message); } catch { replies.push(""); }
      return j({ status: "ok", retcode: 0, data: { message_id: 9999 } });
    }
    j({ status: "ok", retcode: 0, data: null });
  });
});
await new Promise(r => fake.listen(FAKE_PORT, "127.0.0.1", r));

await rm(DATA, { recursive: true, force: true });
await mkdir(DATA, { recursive: true });
const cfg = {
  webhook: { enabled: false, type: "", token: "" },
  llm: real.llm,
  clipboard: { enabled: false, autoAdd: false },
  notifyDesktop: false,
  qq: { enabled: true, api: `http://127.0.0.1:${FAKE_PORT}`, token: "", owner: OWNER, bot: BOT, groups: [] },
  cloud: { enabled: false }
};
await writeFile(join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
await writeFile(join(DATA, "qq-last.json"), JSON.stringify({ lastTime: now - 3600 }), "utf8");
await writeFile(join(DATA, "db.json"), JSON.stringify({ tasks: [presetTask], reminders: [], inbox: [] }, null, 2), "utf8");

const child = spawn(process.execPath, [join(HERE, "src", "server.mjs")], {
  env: { ...process.env, TODO_PORT: String(APP_PORT), TODO_DATA: DATA, TODO_NO_OPEN: "1", TODO_NO_WATCH: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
child.stdout.on("data", d => (out += d));
child.stderr.on("data", d => (out += d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let db = null;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  try { db = JSON.parse(await readFile(join(DATA, "db.json"), "utf8")); } catch { db = null; }
  if (/补处理完成|没有漏掉的消息/.test(out)) break;
}

console.log("--- 日志 ---");
console.log(out.split(/\r?\n/).filter(l => /补处理|助手 →|QQ 收到/.test(l)).join("\n") || "(无)");

const tasks = db?.tasks || [];
const kept = tasks.some(t => t.id === PRESET_ID);
const added = tasks.filter(t => t.id !== PRESET_ID);
const deleted = (out.match(/助手 → delete_tasks/) || []).length;
const notSpam = replyCount <= 1;

console.log("--- 结果 ---");
console.log("任务:", tasks.map(t => t.title).join(" / ") || "(空)");
console.log("预置任务:", kept ? "还在" : "被删了！");
console.log("新记下的:", added.map(t => t.title).join(" / ") || "(无)");
console.log("试图调用删除:", deleted, "次");
console.log("回复条数:", replyCount);
replies.forEach((r,i)=>console.log(`  [${i+1}]`, String(typeof r==="string"?r:JSON.stringify(r)).slice(0,120)));

const pass = kept && deleted === 0 && notSpam;
console.log(pass
  ? "\n[PASS] 真实模型下：老消息里的删除指令被挡住，原有待办安全，没刷屏"
  : `\n[FAIL] 预置任务在=${kept} 删除调用=${deleted} 未刷屏=${notSpam}`);

child.kill("SIGKILL");
fake.close();
await sleep(300);
if (pass) await rm(DATA, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
