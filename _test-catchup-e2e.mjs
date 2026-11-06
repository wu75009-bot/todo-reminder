// 端到端补漏测试：假装 NapCat 里有「关机期间收到的消息」，看服务起来后能不能补记成待办。
// 用 fake OneBot 服务，不碰真实小号，也不碰 data/ 里的真实数据。
//
// 跑法：node _test-catchup-e2e.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "_tc2");
const APP_PORT = 3811;
const FAKE_PORT = 3911;
const OWNER = "10001";
const BOT = "10002";

const now = Math.floor(Date.now() / 1000);
const H = 3600;
// 关机时长（小时）可以由环境变量指定，默认 1 小时
const OFFLINE_H = Number(process.env.OFFLINE_H) > 0 ? Number(process.env.OFFLINE_H) : 1;
// 消息是多久以前发的（小时），默认 20 分钟前。
// 想复现「关机超过 12 小时」的老 bug，就设 MSG_AGE_H=24、OFFLINE_H=48。
const MSG_AGE_S = Number(process.env.MSG_AGE_H) > 0 ? Number(process.env.MSG_AGE_H) * H : 20 * 60;
// catchup（默认）= 期望补到；none = 期望一条都不补
const EXPECT = process.env.EXPECT === "none" ? "none" : "catchup";

// 三个小时后要交的作业、明天早上的班车
const msgs = [
  { message_id: "1001", message_seq: "1001", time: now - MSG_AGE_S, sender: { user_id: Number(OWNER) },
    raw_message: "3小时后提醒我交高数作业", message: [{ type: "text", data: { text: "3小时后提醒我交高数作业" } }] },
  { message_id: "1002", message_seq: "1002", time: now - MSG_AGE_S + 120, sender: { user_id: Number(BOT) },
    raw_message: "好的，记下了", message: [{ type: "text", data: { text: "好的，记下了" } }] },
  { message_id: "1003", message_seq: "1003", time: now - MSG_AGE_S + 300, sender: { user_id: Number(OWNER) },
    raw_message: "", message: [{ type: "image", data: { file: "x.jpg", url: "" } }] },
  // 老消息里的删除指令。重放时绝对不能执行——这条一旦生效，别人的待办就没了。
  { message_id: "1004", message_seq: "1004", time: now - MSG_AGE_S + 360, sender: { user_id: Number(OWNER) },
    raw_message: "删掉吧", message: [{ type: "text", data: { text: "删掉吧" } }] }
];

// 预置一条已存在的待办，用来验证重放老消息不会把它删掉
const PRESET_ID = "preset01";
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
    const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (action === "get_login_info") return j({ status: "ok", retcode: 0, data: { user_id: Number(BOT), nickname: "。" } });
    if (action === "get_friend_msg_history") {
      return j({ status: "ok", retcode: 0, data: { messages: msgs } });
    }
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
  llm: { enabled: false },
  clipboard: { enabled: false, autoAdd: false },
  notifyDesktop: false,
  qq: { enabled: true, api: `http://127.0.0.1:${FAKE_PORT}`, token: "", owner: OWNER, bot: BOT, groups: [] },
  cloud: { enabled: false }
};
await writeFile(join(DATA, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
// 水位设在 N 小时前，模拟「上次运行是 N 小时前，之后关机」
await writeFile(join(DATA, "qq-last.json"), JSON.stringify({ lastTime: now - OFFLINE_H * H }), "utf8");
// 预置数据：一条已有待办，让补漏去重放老消息时有机会误删它
await writeFile(join(DATA, "db.json"), JSON.stringify({
  tasks: [presetTask], reminders: [], inbox: []
}, null, 2), "utf8");

const child = spawn(process.execPath, [join(HERE, "src", "server.mjs")], {
  env: { ...process.env, TODO_PORT: String(APP_PORT), TODO_DATA: DATA, TODO_NO_OPEN: "1", TODO_NO_WATCH: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
child.stdout.on("data", d => (out += d));
child.stderr.on("data", d => (out += d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let db = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  try { db = JSON.parse(await readFile(join(DATA, "db.json"), "utf8")); } catch { db = null; }
  if (/补处理完成|没有漏掉的消息/.test(out)) break;
  // 预置了一条任务，所以「有新任务」的判据是超过 1 条
  if (db && (db.tasks || []).length > 1) break;
}

const tasks = db?.tasks || [];
const found = tasks.find(t => /高数/.test(t.title || ""));
const wm = JSON.parse(await readFile(join(DATA, "qq-last.json"), "utf8").catch(() => "{}")).lastTime;

console.log("--- 输出 ---");
console.log(out.split(/\r?\n/).filter(l => /补处理|QQ 收到|已启动/.test(l)).join("\n") || "(无相关日志)");
console.log("--- 结果 ---");
console.log("任务数", tasks.length, "|", tasks.map(t => t.title).join(" / "));
console.log("作业那条:", found ? `已建（${found.start || found.due}），提醒 ${(db.reminders || []).filter(r => r.taskId === found.id).length} 条` : "没建");
console.log("水位推进:", wm > now - 60 ? "已推到当前" : `仍是 ${new Date(wm * 1000).toLocaleString("zh-CN", { hour12: false })}`);
console.log("回复条数", replyCount, replyCount <= 1 ? "(只有汇总，没刷屏)" : "(逐条回了，会刷屏！)");
console.log("原有待办:", tasks.some(t => t.id === PRESET_ID) ? "还在" : "被删了！");

const notDeleted = tasks.some(t => t.id === PRESET_ID);
const notSpamming = replyCount <= 1;
const pass = EXPECT === "none"
  ? !found
  : Boolean(found) && (db.reminders || []).some(r => r.taskId === found.id) && notDeleted && notSpamming;

console.log(pass
  ? (EXPECT === "none"
      ? "\n[PASS] 比水位更老的消息没有被重复处理"
      : "\n[PASS] 补记为待办并排上提醒；没逐条回复；老消息里的「删掉吧」没有生效")
  : `\n[FAIL] ${EXPECT === "none" ? "旧消息被重复处理了" : `补漏异常（建任务=${Boolean(found)} 原有任务在=${notDeleted} 未刷屏=${notSpamming}）`}`);

child.kill("SIGKILL");
fake.close();
await sleep(300);
if (pass) await rm(DATA, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
