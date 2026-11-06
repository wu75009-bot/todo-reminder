// 对话质量检查：把用户真实说过的那几句话再问一遍，看新提示词下答得怎么样。
// 用隔离实例 + 假 OneBot，只碰测试目录，不动真实数据。
//
// 跑法：node _test-chat-quality.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "_tcq");
const APP_PORT = 3813;
const FAKE_PORT = 3913;
const OWNER = "10001";
const BOT = "10002";

const real = JSON.parse(await readFile(join(HERE, "data", "config.json"), "utf8"));

const asked = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = req.url.replace(/^\//, "").split("?")[0];
    const j = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (action === "get_login_info") return j({ status: "ok", retcode: 0, data: { user_id: Number(BOT), nickname: "。" } });
    if (action === "get_friend_msg_history") return j({ status: "ok", retcode: 0, data: { messages: [] } });
    if (action === "send_private_msg") {
      try {
        const m = JSON.parse(body || "{}").message;
        asked.push(typeof m === "string" ? m : (m || []).map(x => x.data?.text || "").join(""));
      } catch { asked.push(""); }
      return j({ status: "ok", retcode: 0, data: { message_id: 9999 } });
    }
    j({ status: "ok", retcode: 0, data: null });
  });
});
await new Promise(r => fake.listen(FAKE_PORT, "127.0.0.1", r));

await rm(DATA, { recursive: true, force: true });
await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, "config.json"), JSON.stringify({
  webhook: { enabled: false, type: "", token: "" },
  llm: real.llm,
  clipboard: { enabled: false, autoAdd: false },
  notifyDesktop: false,
  qq: { enabled: true, api: `http://127.0.0.1:${FAKE_PORT}`, token: "", owner: OWNER, bot: BOT, groups: [] },
  cloud: { enabled: false }
}, null, 2), "utf8");

const child = spawn(process.execPath, [join(HERE, "src", "server.mjs")], {
  env: { ...process.env, TODO_PORT: String(APP_PORT), TODO_DATA: DATA, TODO_NO_OPEN: "1", TODO_NO_WATCH: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
child.stdout.on("data", d => (out += d));
child.stderr.on("data", d => (out += d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(6000);

async function say(text) {
  const before = asked.length;
  await fetch(`http://127.0.0.1:${APP_PORT}/api/onebot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      post_type: "message", message_type: "private",
      raw_message: text, self_id: Number(BOT),
      sender: { user_id: Number(OWNER) }, user_id: Number(OWNER),
      message_id: String(Date.now()), time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text } }]
    })
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (asked.length > before) return asked[asked.length - 1];
  }
  return "(超时没回)";
}

// 先放一条真待办，后面才好问「删了没」「还有哪些」
console.log("\n>>> 12月5日上午9点去教务处交材料");
console.log(await say("12月5日上午9点去教务处交材料"));

const questions = [
  "所以说你还是没有提醒功能对吗 只能记录",
  "现在有哪些待办",
  "帮我删掉吧",
  "现在还有哪些待办",
  "我明天要交高数作业，还没写完，晚上还有课，你觉得我该怎么办"
];

for (const q of questions) {
  console.log(`\n>>> ${q}`);
  console.log(await say(q));
}

child.kill("SIGKILL");
fake.close();
await sleep(300);
await rm(DATA, { recursive: true, force: true });
