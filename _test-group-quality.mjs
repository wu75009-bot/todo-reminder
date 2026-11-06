// 群聊回答质量检查：把群里真实问过的那几句再问一遍，看是不是还给得出具体答案。
// 隔离实例 + 假 OneBot，只碰测试目录。
//
// 跑法：node _test-group-quality.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "_tcg");
const APP_PORT = 3814;
const FAKE_PORT = 3914;
const OWNER = "10001";
const BOT = "10002";
const GID = "900001";

const real = JSON.parse(await readFile(join(HERE, "data", "config.json"), "utf8"));

const said = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const action = req.url.replace(/^\//, "").split("?")[0];
    const j = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (action === "get_login_info") return j({ status: "ok", retcode: 0, data: { user_id: Number(BOT), nickname: "。" } });
    if (action === "get_friend_msg_history") return j({ status: "ok", retcode: 0, data: { messages: [] } });
    if (action === "send_group_msg" || action === "send_private_msg") {
      try {
        const m = JSON.parse(body || "{}").message;
        said.push(typeof m === "string" ? m : (m || []).map(x => x.data?.text || "").join(""));
      } catch { said.push(""); }
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
  qq: {
    enabled: true, api: `http://127.0.0.1:${FAKE_PORT}`, token: "",
    owner: OWNER, bot: BOT, groups: [GID],
    groupMode: "chatty", groupCooldownMs: 0, groupMaxPerHour: 0,
    botAlias: ["小助手"]
  },
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

const NICK = "示例昵称乙";
let n = 0;
async function groupSay(text) {
  const before = said.length;
  await fetch(`http://127.0.0.1:${APP_PORT}/api/onebot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      post_type: "message", message_type: "group", self_id: Number(BOT),
      group_id: Number(GID), user_id: Number(OWNER),
      sender: { user_id: Number(OWNER), card: NICK, nickname: NICK },
      raw_message: text, message_id: `${Date.now()}${++n}`,
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text } }]
    })
  });
  // 群消息有去抖 + 串行，等久一点
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (said.length > before) return said[said.length - 1];
  }
  return "(没说话)";
}

const questions = [
  "给我推荐一个超影阵容 包括密卷通灵",
  "不是你玩过吗 要选三个",
  "你知道示例村吗",
  "？你确定吗",
  "你王者什么段位"
];

for (const q of questions) {
  console.log(`\n>>> ${q}`);
  console.log(await groupSay(q));
}

child.kill("SIGKILL");
fake.close();
await sleep(300);
await rm(DATA, { recursive: true, force: true });
