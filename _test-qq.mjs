// 用假 NapCat 把「转发给小号 → 识别 → 回复 → 排提醒」整条链路跑一遍。
// 不碰真实数据目录，也不需要在真机上装任何东西。
import { spawn } from "node:child_process";
import http from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname);
const PORT = 3793;
const MOCK = 3820;
const DATA = join(ROOT, "_test-data");
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ✅", label); }
  else { fail++; console.log("  ❌", label, extra ? `— ${extra}` : ""); }
};

// ---- 假 NapCat ----
const sent = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const action = req.url.replace(/^\//, "");
    const payload = body ? JSON.parse(body) : {};
    res.writeHead(200, { "content-type": "application/json" });
    if (action === "send_private_msg") {
      sent.push(payload);
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 900 + sent.length } }));
    } else if (action === "get_login_info") {
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 20002, nickname: "小助手" } }));
    } else if (action === "get_forward_msg") {
      res.end(JSON.stringify({
        status: "ok", retcode: 0,
        data: {
          messages: [
            { sender: { nickname: "班长" }, message: [{ type: "text", data: { text: "周五下午三点开班会，教三 302" } }] },
            { sender: { nickname: "班长" }, message: [{ type: "text", data: { text: "记得带笔记本电脑" } }] }
          ]
        }
      }));
    } else {
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
    }
  });
});
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));

// ---- 隔离数据目录 ----
await rm(DATA, { recursive: true, force: true });
await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, "config.json"), JSON.stringify({
  qq: { enabled: true, api: `http://127.0.0.1:${MOCK}`, owner: "10001", bot: "20002" }
}, null, 2), "utf8");
await writeFile(join(DATA, "db.json"), JSON.stringify({ tasks: [], reminders: [], inbox: [] }), "utf8");

const errors = [];
const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, TODO_PORT: String(PORT), TODO_DATA: DATA, TODO_NO_WATCH: "1", TODO_NO_OPEN: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", d => { const s = String(d); if (/错误|出错|失败/.test(s)) errors.push(s.trim()); });
server.stderr.on("data", d => errors.push(String(d).trim()));

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}
if (!await waitUp()) { console.log("服务没起来：", errors.join("\n")); process.exit(1); }

const post = async (path, body, headers = {}) => {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};

const privateMsg = (userId, message, id = Math.floor(Math.random() * 1e6)) => ({
  post_type: "message", message_type: "private", sub_type: "friend",
  self_id: 20002, user_id: userId, message_id: id, raw_message: "", message
});
const txt = t => [{ type: "text", data: { text: t } }];

console.log("\n--- 1. 转发一条作业通知 ---");
await post("/api/onebot", privateMsg(10001, txt("【大学物理】实验报告于11月10日23:59前提交到学习通，逾期不候。")));
await sleep(1200);
ok(sent.length === 1, "小号回了一条消息", `实际 ${sent.length} 条`);
const reply1 = sent[0]?.message?.[0]?.data?.text || "";
ok(reply1.includes("已记下"), "回复里有「已记下」", reply1.split("\n")[0]);
ok(reply1.includes("11-10") || reply1.includes("11/10") || /11.*10/.test(reply1), "回复里有截止日期", reply1);
ok(/提前|会提醒你/.test(reply1), "回复里列出了提醒时间");

console.log("\n--- 2. 陌生人发消息（不该理） ---");
const before = sent.length;
await post("/api/onebot", privateMsg(99999, txt("11月1日 15:00 开会")));
await sleep(800);
ok(sent.length === before, "陌生人没触发任何回复");

console.log("\n--- 3. 重复上报同一条（message_id 相同） ---");
const before2 = sent.length;
await post("/api/onebot", privateMsg(10001, txt("【大学物理】实验报告于11月10日23:59前提交到学习通，逾期不候。"), 88888));
await post("/api/onebot", privateMsg(10001, txt("【大学物理】实验报告于11月10日23:59前提交到学习通，逾期不候。"), 88888));
await sleep(1200);
ok(sent.length - before2 === 1, "同一条只处理一次", `实际 ${sent.length - before2} 次`);

console.log("\n--- 4. 合并转发（两条消息合成一个日程） ---");
await post("/api/onebot", privateMsg(10001, [{ type: "forward", data: { id: "fw-1" } }]));
await sleep(1200);
const reply4 = sent[sent.length - 1]?.message?.[0]?.data?.text || "";
ok(/班会/.test(reply4), "认出了合并转发里的班会", reply4.split("\n")[0]);
ok(/星期五|11-0|15:00|15 点/.test(reply4) || /开始/.test(reply4), "带上了时间", reply4);

console.log("\n--- 5. 缺时间的通知 → 追问 → 补时间 ---");
await post("/api/onebot", privateMsg(10001, txt("下周要交实验报告，记得写")));
await sleep(1000);
const reply5 = sent[sent.length - 1]?.message?.[0]?.data?.text || "";
ok(/认出来了|缺时间|回一句/.test(reply5), "缺时间时主动追问", reply5.split("\n").join(" / "));
await post("/api/onebot", privateMsg(10001, txt("11月12日 18:00")));
await sleep(1000);
const reply6 = sent[sent.length - 1]?.message?.[0]?.data?.text || "";
ok(/11-12|11\/12/.test(reply6), "补上时间后确认了", reply6.split("\n").join(" / "));
ok(/会提醒你/.test(reply6), "补完就排上了提醒", reply6);

console.log("\n--- 6. 状态 / 取消 ---");
await post("/api/onebot", privateMsg(10001, txt("状态")));
await sleep(900);
const reply7 = sent[sent.length - 1]?.message?.[0]?.data?.text || "";
ok(/手上有/.test(reply7), "状态能列出待办", reply7.split("\n")[0]);
const idMatch = /^([0-9a-f]{8})/m.exec(reply7);
ok(Boolean(idMatch), "状态里带编号");
if (idMatch) {
  await post("/api/onebot", privateMsg(10001, txt(`取消 ${idMatch[1]}`)));
  await sleep(900);
  const reply8 = sent[sent.length - 1]?.message?.[0]?.data?.text || "";
  ok(/删了/.test(reply8), "取消能删掉", reply8);
}

console.log("\n--- 7. 到点提醒走 QQ 私聊 ---");
const before3 = sent.length;
await post("/api/test-notify", {});
await sleep(1200);
ok(sent.length > before3, "测试通知发到了 QQ");
const lastSend = sent[sent.length - 1];
ok(String(lastSend?.user_id) === "10001", "发给了主人号", String(lastSend?.user_id));

console.log("\n--- 8. 配置对外不泄露令牌 ---");
await post("/api/config", { qq: { token: "secret-token-abc", enabled: true } });
const st = await fetch(`${BASE}/api/state`).then(r => r.json());
ok(st.config.qq.hasToken === true, "状态里只说有没有令牌");
ok(!JSON.stringify(st.config.qq).includes("secret-token-abc"), "状态里没有明文令牌");

console.log("\n--- 9. 令牌校验 ---");
const b4 = sent.length;
await post("/api/onebot", privateMsg(10001, txt("11月20日 10:00 开会")), { authorization: "Bearer wrong" });
await sleep(800);
ok(sent.length === b4, "令牌不对的消息被拒");

const db = JSON.parse(await readFile(join(DATA, "db.json"), "utf8"));
ok(db.tasks.length >= 2, "任务确实落盘了", `实际 ${db.tasks.length} 条`);
ok(db.reminders.length >= 2, "提醒确实排上了", `实际 ${db.reminders.length} 条`);

if (errors.length) console.log("\n服务端异常输出：\n" + errors.slice(0, 5).join("\n"));

server.kill();
mock.close();
await rm(DATA, { recursive: true, force: true });
console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
