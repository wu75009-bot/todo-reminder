// 群消息回归：常驻群里，有上下文，自己判断要不要接话。
// 真实 DeepSeek + 假 NapCat + 隔离数据目录，不碰真实账号。
// 跑法：node _test-group.mjs

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const PORT = 3803;
const MOCK = 3904;
const OWNER = "10001";     // 主人
const BOT = "10002";       // 小号自己
const OTHER = "10003";     // 群里的同学
const GID = "888001";
const GNAME = "软件 2301 班群";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  → " + detail : ""}`); }
};

const sent = [];
let imgBuf = null;
try { imgBuf = await readFile(join(process.cwd(), "_test-group-img.png")); } catch { /* 没图就跳过图片用例 */ }

const mock = http.createServer((req, res) => {
  // 假 NapCat 顺便当图床：群里发图后 fetchImage 会来这儿下载
  if (String(req.url || "").startsWith("/img/")) {
    if (!imgBuf) { res.statusCode = 404; res.end("no image"); return; }
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
    if (action === "get_group_list") {
      res.end(JSON.stringify({
        status: "ok", retcode: 0,
        data: [{ group_id: Number(GID), group_name: GNAME, member_count: 8 }]
      }));
      return;
    }
    let text = "";
    let j = {};
    try { j = JSON.parse(body || "{}"); text = (j.message || []).map(m => m?.data?.text || "").join(""); } catch {}
    sent.push({ action, group: String(j.group_id || ""), user: String(j.user_id || ""), text });
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

const dataDir = await mkdtemp(join(tmpdir(), "todo-group-"));
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm,
  qq: {
    enabled: true, api: `http://127.0.0.1:${MOCK}`, token: "",
    owner: OWNER, bot: BOT, groups: [],
    groupMode: "chatty",
    groupCooldownMs: 0,        // 0 = 不限：用户明确要求「不用设置上限」
    groupMaxPerHour: 0,
    botAlias: ["小助手"]
  }
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

let mid = 800001;

function event({ type = "group", from = OWNER, text = "", at = false, nick = "某人", image = null }) {
  const segs = [];
  if (at) segs.push({ type: "at", data: { qq: BOT } });
  if (text) segs.push({ type: "text", data: { text } });
  if (image) {
    segs.push({
      type: "image",
      data: { file: "test.png", url: `http://127.0.0.1:${MOCK}/img/test.png`, sub_type: 0 }
    });
  }
  return {
    post_type: "message",
    message_type: type,
    sub_type: type === "group" ? "normal" : "friend",
    group_id: type === "group" ? Number(GID) : undefined,
    self_id: Number(BOT),
    user_id: Number(from),
    message_id: ++mid,
    time: Math.floor(Date.now() / 1000),
    message: segs,
    raw_message: (at ? `[CQ:at,qq=${BOT}] ` : "") + text + (image ? "[CQ:image,file=test.png]" : ""),
    sender: { user_id: Number(from), nickname: nick }
  };
}

async function push(ev, waitMs = 60000) {
  const before = sent.length;
  await fetch(`http://127.0.0.1:${PORT}/api/onebot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev)
  });
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(400);
    if (sent.slice(before).some(s => s.action === "send_group_msg" || s.action === "send_private_msg")) break;
  }
  // 没回话的场景多等一会儿，确认它是真的不说，而不是还没说完
  if (sent.length === before) await sleep(6000);
  return sent.slice(before);
}

// 只投递，不等回复（用来测去抖合并）
async function fire(ev) {
  await fetch(`http://127.0.0.1:${PORT}/api/onebot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev)
  });
}

try {
  await sleep(5000);

  // 0. 连发两条 → 攒成一次问模型，不逐条回
  const before0 = sent.length;
  await fire(event({ text: "明天下午两点在三教201开会，都别迟到", nick: "班长" }));
  await sleep(300);
  await fire(event({ text: "有人去吗？", nick: "张三" }));
  await sleep(22000);
  const g0 = sent.slice(before0).filter(s => s.action === "send_group_msg");
  check("连发两条不逐条回（去抖合并）", g0.length <= 1, `${g0.length} 条：${JSON.stringify(g0.map(s => s.text.slice(0, 40)))}`);
  if (g0[0]) console.log("  [群里0]", g0[0].text.replace(/\n/g, " / ").slice(0, 140));

  // 1. 别人发的通知不该自动记成待办（你明确说过不要读群通知）
  const s1 = await state();
  check("别人发的通知不建待办", (s1.tasks || []).length === 0, JSON.stringify((s1.tasks || []).map(t => t.title)));

  // 2. 纯附和 → 更不该出声
  const out2 = await push(event({ text: "收到", nick: "李四" }));
  check("「收到」不接", out2.length === 0, JSON.stringify(out2));

  // 3. 有人提问 → 自己判断要不要开口（这条是「不用 @ 也能说话」的关键）
  const out3 = await push(event({ text: "明天开会是几点来着？", nick: "张三" }));
  const g3 = out3.filter(s => s.action === "send_group_msg");
  check("有人提问会接话", g3.length > 0, JSON.stringify(out3));
  if (g3[0]) console.log("  [群里3]", g3[0].text.replace(/\n/g, " / ").slice(0, 120));

  // 4. 上下文：@ 它问前面聊过的事，它得知道
  const out4 = await push(event({ text: "刚说的会几点开？在哪个教室？", at: true, nick: "王五" }));
  const g4 = out4.filter(s => s.action === "send_group_msg");
  const t4 = g4[0]?.text || "";
  check("@ 之后回话了", g4.length > 0, JSON.stringify(out4));
  check("答得出前面的两点", /两点|2\s*点|14[:：]00/.test(t4), t4);
  check("答得出前面的三教201", /三教\s*201|201/.test(t4), t4);
  if (t4) console.log("  [群里4]", t4.replace(/\n/g, " / ").slice(0, 160));

  // 5. 主人 @ 它记一条 → 建待办
  const out5 = await push(event({ text: "记一下，明天下午两点在三教201开会", at: true }));
  const s5 = await state();
  const g5 = out5.filter(s => s.action === "send_group_msg");
  check("主人 @ 能记待办", (s5.tasks || []).length === 1, JSON.stringify((s5.tasks || []).map(t => t.title)));
  check("主人 @ 在群里回了", g5.length > 0, JSON.stringify(out5));
  if (g5[0]) console.log("  [群里5]", g5[0].text.replace(/\n/g, " / ").slice(0, 140));

  // 6. 群里有人发图（一句文字都没有）→ 必须看得见
  if (imgBuf) {
    const out6 = await push(event({ from: OTHER, image: true, nick: "李四" }));
    const g6 = out6.filter(s => s.action === "send_group_msg");
    const t6 = g6[0]?.text || "";
    check("纯图片也会接话（不再当空消息扔掉）", g6.length > 0, JSON.stringify(out6));
    check("回复里带图上的字（作业/周五/502）", /作业|周五|502|10\s*点|十点/.test(t6), t6);
    check("不再说看不见图", !/看不见|看不到|加载不|一片空白|刷不出|描述一下|发文字/.test(t6), t6);
    if (t6) console.log("  [群里6-图]", t6.replace(/\n/g, " / ").slice(0, 160));

    // 7. 隔一句再问「刚那张图写的啥」→ 上下文里得存着这张图
    const out7 = await push(event({ text: "刚那张图写的啥来着？", nick: "张三" }));
    const g7 = out7.filter(s => s.action === "send_group_msg");
    const t7 = g7[0]?.text || "";
    check("隔一句还记得那张图", /作业|周五|502|10\s*点|十点/.test(t7), t7);
    if (t7) console.log("  [群里7-图上下文]", t7.replace(/\n/g, " / ").slice(0, 160));
  } else {
    console.log("  (没找到 _test-group-img.png，跳过图片用例)");
  }

  // 8. 同学 @ 它想让它记事 → 可以回，但不能建待办
  const out8 = await push(event({ from: OTHER, text: "帮我记一下后天下午三点交实验报告", at: true, nick: "赵六" }));
  const s8 = await state();
  const g8 = out8.filter(s => s.action === "send_group_msg");
  check("同学 @ 也回话（不设上限）", g8.length > 0, JSON.stringify(out8));
  check("同学 @ 不能建待办", (s8.tasks || []).length === 1, JSON.stringify((s8.tasks || []).map(t => t.title)));
  if (g8[0]) console.log("  [群里8]", g8[0].text.replace(/\n/g, " / ").slice(0, 120));

  // 9. 私聊不受影响（回归）
  const out9 = await push(event({ type: "private", text: "我有什么待办" }));
  const p9 = out9.filter(s => s.action === "send_private_msg");
  check("私聊照常能用", p9.length > 0 && /开会|会议/.test(p9[0].text), JSON.stringify(out9));
  if (p9[0]) console.log("  [私聊9]", p9[0].text.replace(/\n/g, " / ").slice(0, 120));
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
if (fail) console.log("\n--- 服务输出 ---\n" + stdout.slice(-4000));
process.exit(fail ? 1 : 0);
