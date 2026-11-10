import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, appendFile, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { parse, expandReminders, iso } from "./parser.mjs";
import { RuleBook } from "./rules.mjs";
import { Store } from "./store.mjs";
import { Scheduler } from "./scheduler.mjs";
import { toast, webhook, ocrImage, tidyOcr, workFile } from "./push.mjs";
import { llmConfig, llmReady, llmParse, llmIntent, llmProbe, publicLlmConfig, llmDescribeImage } from "./llm.mjs";
import { runWithTools } from "./agent.mjs";
import { startClipboardWatcher } from "./watch.mjs";
import { startOneBotWs } from "./onebot-ws.mjs";
import { sendMail } from "./mail.mjs";
import { createMemory } from "./memory.mjs";
import { qqConfig, sendPrivate, sendPrivateFile, sendGroup, atTarget, groupList, probe as qqProbe, readMessage, fetchImage, friendHistory } from "./onebot.mjs";
import { buildIcs } from "./ics.mjs";
import { webSearch, fetchPage, searchToText } from "./websearch.mjs";
import { ensure as scfEnsure, pushQueue, invokeTest as scfInvokeTest } from "./scf.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.TODO_PORT || 3790);
// 数据目录可换，测试时指到临时目录，就不会动到真实的任务和密钥
const DATA = process.env.TODO_DATA || join(ROOT, "data");
const CONFIG_PATH = join(DATA, "config.json");

// 日志同时写控制台和 data/logs/日期.log。
// 后台用 vbs 启动时没有控制台，出问题就没证据，所以必须落盘。
const LOG_DIR = join(DATA, "logs");
await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
function logFile() {
  return join(LOG_DIR, `${new Date().toLocaleDateString("sv-SE")}.log`);
}
const log = (...a) => {
  const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`;
  console.log(line);
  appendFile(logFile(), line + "\n").catch(() => {});
};
// 只留最近 7 天的日志
(async () => {
  const keep = new Set(Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return `${d.toLocaleDateString("sv-SE")}.log`;
  }));
  const files = await readdir(LOG_DIR).catch(() => []);
  for (const f of files) if (f.endsWith(".log") && !keep.has(f)) unlink(join(LOG_DIR, f)).catch(() => {});
})();

const ruleBook = new RuleBook(join(ROOT, "rules"));
await ruleBook.load();
const store = new Store(join(DATA, "db.json"));
await store.init();

// 长期记忆：待办之外，聊过的事也要能活过一天。
// 和任务分开存，删任务不会连带把「他是谁、说过什么」一起清掉。
const memory = createMemory({ path: join(DATA, "memory.json") });
const memCount = await memory.load();

const CLIP_DEFAULTS = { enabled: true, autoAdd: true, onlyFromQQ: true };
const QQ_DEFAULTS = { enabled: false, api: "http://127.0.0.1:3000", token: "", owner: "", bot: "", groups: [] };
// 云端守时器：电脑关机后靠它到点发微信。url 是部署好的 Worker 地址。
const CLOUD_DEFAULTS = { enabled: false, url: "", token: "", days: 7 };
// 掉线告警：NapCat 掉线时 QQ 这条路本身就是断的，所以走邮件这条独立通道。
const ALERT_SMTP_DEFAULTS = { host: "smtp.qq.com", port: 465, user: "", pass: "", to: "" };
const ALERT_DEFAULTS = { enabled: false, offlineMinutes: 10, notifyOnRecover: true, smtp: { ...ALERT_SMTP_DEFAULTS } };
// 手机端入口。QQ 那条路 2026-11 被风控彻底堵死之后，这是替代方案：
// 手机浏览器打开一个带密钥的链接，就是全部入口，不依赖任何第三方账号。
// 必须带 token，否则等于把待办列表挂在公网上；没配 token 时公网监听直接不启动。
const MOBILE_DEFAULTS = { enabled: false, port: 6099, token: "" };

let config = {
  webhook: { enabled: false, type: "pushplus", token: "", url: "" },
  llm: {},
  clipboard: { ...CLIP_DEFAULTS },
  qq: { ...QQ_DEFAULTS },
  cloud: { ...CLOUD_DEFAULTS },
  alert: { ...ALERT_DEFAULTS },
  mobile: { ...MOBILE_DEFAULTS }
};
try {
  const disk = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  config = {
    ...config,
    ...disk,
    webhook: { ...config.webhook, ...(disk.webhook || {}) },
    llm: disk.llm || {},
    clipboard: { ...CLIP_DEFAULTS, ...(disk.clipboard || {}) },
    qq: { ...QQ_DEFAULTS, ...(disk.qq || {}) },
    cloud: { ...CLOUD_DEFAULTS, ...(disk.cloud || {}) },
    alert: {
      ...ALERT_DEFAULTS,
      ...(disk.alert || {}),
      smtp: { ...ALERT_SMTP_DEFAULTS, ...(disk.alert?.smtp || {}) }
    },
    mobile: { ...MOBILE_DEFAULTS, ...(disk.mobile || {}) }
  };
} catch { /* 首次运行 */ }

// 密钥没配就现场生成一个并落盘，省得用户手搓。
// 用 randomBytes 而不是 Math.random：这个串就是这台服务器的唯一门锁。
if (!config.mobile.token) {
  const { randomBytes } = await import("node:crypto");
  config.mobile.token = randomBytes(18).toString("base64url");
  try {
    const disk = await readFile(CONFIG_PATH, "utf8").then(JSON.parse).catch(() => ({}));
    disk.mobile = { ...(disk.mobile || {}), token: config.mobile.token };
    await mkdir(DATA, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(disk, null, 2), "utf8");
    log(`手机端密钥已生成，访问链接形如 /m?t=${config.mobile.token}`);
  } catch (err) {
    log("手机端密钥生成后写盘失败：", err.message);
  }
}

async function saveConfig(next) {
  // llm / webhook 单独合并：密钥类字段传空值时保留原值，
  // 免得网页只是改个开关就把已存的 key 抹掉
  if (next.llm) {
    const prev = config.llm || {};
    const merged = { ...prev, ...next.llm };
    if (next.llm.apiKey === undefined || next.llm.apiKey === "") merged.apiKey = prev.apiKey || "";
    next = { ...next, llm: merged };
  }
  if (next.webhook) {
    const prev = config.webhook || {};
    const merged = { ...prev, ...next.webhook };
    if (!next.webhook.token || next.webhook.token === "已填写") merged.token = prev.token || "";
    next = { ...next, webhook: merged };
  }
  if (next.clipboard) {
    next = { ...next, clipboard: { ...config.clipboard, ...next.clipboard } };
  }
  if (next.qq) {
    next = { ...next, qq: { ...config.qq, ...next.qq } };
  }
  if (next.cloud) {
    const prev = config.cloud || {};
    const merged = { ...prev, ...next.cloud };
    if (!next.cloud.token || next.cloud.token === "已填写") merged.token = prev.token || "";
    next = { ...next, cloud: merged };
  }
  config = { ...config, ...next };
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  return config;
}

// 到点提醒发到 QQ 私聊。电脑开着才发得出去，这是小号方案唯一的前提。
async function pushQQ({ title, body }) {
  const cfg = qqConfig(config.qq);
  if (!cfg.enabled) return { ok: false, skipped: true };
  const text = body ? `【${title}】\n${body}` : `【${title}】`;
  const r = await sendPrivate(cfg, text);
  if (!r.ok) log("QQ 提醒没发出去：", r.error);
  return r;
}

// QQ 发不出去时的兜底通道。
// 为什么值得有：小号被风控时一小时掉一次，那段时间提醒全丢，而「准时响」
// 是这个工具唯一的价值。邮件走独立 SMTP，只要服务器活着就发得出去。
// 开关是 config.mailFallback，默认关；SMTP 配置复用 alert.smtp 那一套。
async function pushMail({ title, body }) {
  if (config.mailFallback !== true) return { ok: false, skipped: true };
  const smtp = { ...ALERT_SMTP_DEFAULTS, ...(config.alert?.smtp || {}) };
  if (!smtp.user || !smtp.pass) {
    log("提醒邮件没发出去：还没填发件邮箱或授权码");
    return { ok: false, error: "missing config" };
  }
  const text = body ? `${title}\n\n${body}` : String(title || "提醒");
  try {
    const r = await sendMail(smtp, { subject: `【提醒】${title}`, text });
    log(`QQ 发不出去，这条提醒改发邮件到 ${r.to}`);
    return { ok: true, to: r.to };
  } catch (err) {
    log("提醒邮件也没发出去：", err.message);
    return { ok: false, error: err.message };
  }
}

// 掉线告警。为什么必须走邮件：小号掉线的时候，QQ 这条路本身已经断了，
// 用它通知等于没通知。邮件走的是完全独立的 SMTP 连接。
async function sendAlert(subject, text) {
  const a = config.alert || {};
  if (a.enabled !== true) return { ok: false, skipped: true };
  const smtp = { ...ALERT_SMTP_DEFAULTS, ...(a.smtp || {}) };
  if (!smtp.user || !smtp.pass) {
    log("告警邮件没发出去：还没填发件邮箱或授权码");
    return { ok: false, error: "missing config" };
  }
  try {
    const r = await sendMail(smtp, { subject, text });
    log(`告警邮件已发到 ${r.to}`);
    return { ok: true };
  } catch (err) {
    log("告警邮件没发出去：", err.message);
    return { ok: false, error: err.message };
  }
}

// 到点只往手机 QQ 发，电脑上不弹任何东西。
// 托盘通知默认关掉：坐在电脑前时自己看得见屏幕，弹窗反而是噪音。
// 想开回来把 config.notifyDesktop 设成 true。
async function notify(payload) {
  if (config.notifyDesktop === true) {
    const r = await toast(payload.title, payload.body);
    payload.toast = r.ok;
    if (!r.ok) log("托盘通知失败：", r.detail);
  } else {
    payload.toast = false;
  }
  const q = await pushQQ(payload);
  payload.qq = q.ok ? "ok" : (q.skipped ? "skip" : (q.error || "失败"));
  // QQ 这条路断了（掉线 / 没启用）就走邮件，别让这条提醒直接人间蒸发。
  // 只在发失败时补一次，QQ 正常时不会多发邮件。
  if (!q.ok) {
    const m = await pushMail(payload);
    payload.mail = m.ok ? "ok" : (m.skipped ? "skip" : (m.error || "失败"));
  }
  const w = await webhook(config, payload);
  payload.webhook = w.ok ? "ok" : (w.skipped ? "skip" : (w.error || `HTTP ${w.status}`));
  return payload;
}

const scheduler = new Scheduler({
  store,
  notify,
  onEvent: e => {
    log("event", JSON.stringify(e));
    if (e.type === "reminder-sent") kickCloudSync("已发出，云端要撤掉");
  }
});
const caught = await scheduler.catchUp();
if (caught.resent || caught.missed) log(`启动补发：${caught.resent} 条，标记错过 ${caught.missed} 条`);
scheduler.start();

// 开机先对齐一次云端，之后每 10 分钟对一次（防止中间改过任务没同步上）
if (config.cloud?.enabled) {
  setTimeout(() => syncCloud("启动对齐"), 6000);
  setInterval(() => syncCloud("定时对齐"), 10 * 60_000);
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  // 已经回过一次就别再写了。以前 res.end() 的返回值被当成"没拦住"，
  // 又走了一遍 send，Node 直接抛 ERR_HTTP_HEADERS_SENT 把整个进程带走。
  if (res.headersSent || res.writableEnded) {
    log("重复响应已忽略：", code, res.req?.url || "");
    return;
  }
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  if (typeof body === "string") return res.end(body);
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { rej(new Error("内容太大了")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return res({});
      try { res(JSON.parse(raw)); } catch (err) { rej(new Error("请求格式不对：" + err.message)); }
    });
    req.on("error", rej);
  });
}

// 纯文本 body。给系统分享面板用（QQ/微信长按转发进来的一坨字）。
// 为什么不走 JSON：群消息里引号、换行、反斜杠太常见，套进 JSON 一定被转义咬到，
// 而手机端那个 App 做变量替换时不会帮你转义。
function readRaw(req, limit = 256 * 1024) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { rej(new Error("内容太大了")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

const ANCHOR_LABEL = { start: "开始", end: "结束", due: "截止" };
const shortTime = iso => iso
  ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—";

// 分享回来的确认只有两行 Toast：标题太长、日期重复三遍，都会顶到屏幕外。
function cleanTitle(s) {
  const one = String(s || "").replace(/\s+/g, " ").trim().replace(/[,，。;；、!！?？]+$/, "");
  return one.length > 22 ? one.slice(0, 22) + "…" : one;
}

// 同一天只写一次日期，后面只给时分；超过三条就说"等 N 次"。
function briefTimes(list) {
  const parts = list.map(x => {
    const d = new Date(x.fireAt);
    return {
      day: d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }),
      hm: d.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" }).slice(0, 5)
    };
  });
  if (!parts.length) return "";
  const shown = parts.slice(0, 3).map((p, i) => (i > 0 && p.day === parts[0].day) ? p.hm : `${p.day} ${p.hm}`);
  return shown.join("、") + (parts.length > 3 ? ` 等 ${parts.length} 次` : "");
}

function ruleOf(parsed) {
  const rules = ruleBook.rules || [];
  const hit = rules.find(r => r.id === parsed.type)
    || rules.find(r => r.name === parsed.typeName)
    || rules.find(r => r.name === parsed.type);
  if (hit) return hit;
  // 模型会说「活动」「事务」这类别名，对不上任何规则文件名；
  // 以前这里直接返回 null，结果这条任务一条提醒都排不上（不报错，只是静默不响）。
  // 现在退回默认规则兜底。
  return rules.find(r => r.id === "_默认")
    || rules.find(r => r.name === "其他")
    || rules[0]
    || null;
}

// 未来 N 天要发的提醒，整理成日历条目。
// 导进手机之后就是系统闹钟，跟这台电脑开不开机没关系。
function calendarItems(days = 14) {
  const now = Date.now();
  const until = now + days * 86400000;
  return store.reminders
    .filter(r => r.status === "pending")
    .map(r => ({ r, at: Date.parse(r.fireAt) }))
    .filter(x => Number.isFinite(x.at) && x.at > now - 60_000 && x.at <= until)
    .sort((a, b) => a.at - b.at)
    .map(({ r }) => {
      const t = store.tasks.find(x => x.id === r.taskId);
      return {
        id: r.id,
        fireAt: r.fireAt,
        title: (t?.title || r.text || "提醒").slice(0, 80),
        body: r.text && r.text !== t?.title ? r.text : ""
      };
    });
}

// 导日历用：一条待办 = 一条日程，它的多个提醒点变成这条日程上的多个闹钟。
// 不能按提醒点一条一条生成 —— 同一件事有「提前 1 小时」和「到点」两个提醒点时，
// 手机日历里就会并排出现两条一样的日程，看着像坏了。
function calendarEvents(days = 14) {
  const now = Date.now();
  const until = now + days * 86400000;
  const groups = new Map();

  for (const r of store.reminders) {
    if (r.status !== "pending") continue;
    const at = Date.parse(r.fireAt);
    if (!Number.isFinite(at) || at <= now - 60_000 || at > until) continue;
    const key = r.taskId || r.id;
    if (!groups.has(key)) groups.set(key, { task: store.tasks.find(t => t.id === r.taskId), fires: [] });
    groups.get(key).fires.push(at);
  }

  const out = [];
  const seen = new Map();   // 「标题｜时刻」→ 已加过的事件下标，用来吃掉重复待办

  for (const [key, { task, fires }] of groups) {
    // 日程定在事情本身的时间上（开始 / 截止），提醒点只是它的闹钟。
    const anchor = Date.parse(task?.start || task?.due || task?.end || "");
    const at = Number.isFinite(anchor) ? anchor : Math.min(...fires);

    const alarms = [...new Set(fires.map(f => Math.round((at - f) / 60000)))]
      .filter(m => Math.abs(m) <= 60 * 24 * 30)
      .sort((a, b) => b - a);   // 越早响的排前面，日历里看着顺

    // notes 基本都是解析时的诊断信息（「模型算的是…请核对」「归为其他，请你核对」），
    // 那是给界面上核对用的，塞进日历只会让人一脸问号。日历里只留地点。
    const body = task?.location ? `地点：${task.location}` : "";
    const endAt = Date.parse(task?.end || "");
    const title = (task?.title || "提醒").slice(0, 100);

    // 同一件事被记了两遍时（真实数据里出现过），日历里只留一条，
    // 把两次的提醒点并到一起。手机日历里并排两条一模一样的东西最难受。
    const dupKey = `${title.replace(/\s/g, "")}|${at}`;
    const prevAt = seen.get(dupKey);
    if (prevAt !== undefined) {
      const prev = out[prevAt];
      prev.alarms = [...new Set([...prev.alarms, ...alarms])].sort((a, b) => b - a);
      continue;
    }

    seen.set(dupKey, out.length);
    out.push({
      uid: key,
      at,
      end: Number.isFinite(endAt) && endAt > at ? endAt : null,
      title,
      body,
      alarms: alarms.length ? alarms : [0]
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

// 把提醒导出成 .ics 直接发到主人 QQ。手机上点开就能导进日历，比让他复制一整段
// BEGIN:VCALENDAR 再自己存成文件强得多 —— 那种做法在手机上几乎没人能一次做对。
async function sendIcsToQQ(days = 14) {
  const d = Math.min(60, Math.max(1, Number(days) || 14));
  const items = calendarEvents(d);
  if (!items.length) return { ok: false, count: 0, error: `未来 ${d} 天没有待发的提醒` };

  const name = `待办提醒-${new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).replace(/\//g, "")}.ics`;
  const file = workFile(name);
  await writeFile(file, buildIcs(items, { name: "待办提醒" }), "utf8");

  const r = await sendPrivateFile(qqConfig(config.qq), file, name);
  if (!r.ok) {
    return { ok: false, count: items.length, error: r.skipped ? "QQ 没连上，发不出去" : (r.error || "发送失败") };
  }
  log(`日历已发到 QQ：${name}（${items.length} 条）`);
  return { ok: true, count: items.length, days: d, file: name };
}

// 把未来几天的提醒整份推给云端守时器。
// 这是"电脑关机也能收到消息"的唯一通道：云端自己守着时间，不依赖这台机器在线。
let cloudBusy = false;
let cloudTimer = null;

async function syncCloud(reason = "") {
  const c = config.cloud || {};
  const isScf = c.provider === "scf";
  if (!c.enabled) return { ok: false, skipped: true, reason: "云端没配" };
  if (!isScf && !c.url) return { ok: false, skipped: true, reason: "云端没配" };
  if (cloudBusy) return { ok: false, skipped: true, reason: "上一次还没跑完" };
  cloudBusy = true;
  try {
    const days = Number(c.days) > 0 ? Number(c.days) : 7;
    const items = calendarItems(days).map(it => ({
      id: it.id,
      at: Date.parse(it.fireAt),
      title: it.title,
      body: it.body || ""
    }));

    if (isScf) {
      // 队列编进函数代码，云端每分钟自己检查；电脑关机后仍然到点推送
      const r = c.deployed ? await pushQueue(c, items) : await scfEnsure(c, items);
      if (!c.deployed) await saveConfig({ cloud: { deployed: true } });
      log(`云端同步（腾讯云函数）：${r.count} 条在云端排队${reason ? "，" + reason : ""}`);
      return { ok: true, queued: r.count };
    }
    const res = await fetch(String(c.url).replace(/\/+$/, "") + "/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: c.token || "", items }),
      signal: AbortSignal.timeout(15000)
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
      const msg = j?.error || `HTTP ${res.status}`;
      log("云端同步失败：", msg);
      return { ok: false, error: msg };
    }
    log(`云端同步：${j.queued} 条在云端排队（${reason}）`);
    return { ok: true, queued: j.queued, received: j.received };
  } catch (err) {
    log("云端同步失败：", err.message);
    return { ok: false, error: err.message };
  } finally {
    cloudBusy = false;
  }
}

// 任务一改就推一次，但别改十行就推十次
function kickCloudSync(reason = "任务变动") {
  if (!config.cloud?.enabled) return;
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { cloudTimer = null; syncCloud(reason); }, 3000);
}

// 临时才知道的事（"半小时后开会"），规则里所有「提前 1 小时 / 15 分钟」的
// 时点早就过去了。原来这种任务一条提醒都排不上，等于白记。
// 这里兜一条：只要事情本身还没开始，就先立刻响一次。
function ensureImmediate(task, rule, list, now = Date.now()) {
  if (list.length) return { list, added: null };
  const anchor = rule?.defaultAnchor || (task.due ? "due" : "start");
  const iso = task[anchor] || task.start || task.due || task.end;
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at) || at <= now) return { list, added: null };
  const when = new Date(at).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  const label = ANCHOR_LABEL[anchor] || "开始";
  const mins = Math.max(1, Math.round((at - now) / 60000));
  const text = mins >= 90
    ? `${label}时间 ${when}，还有约 ${Math.round(mins / 60)} 小时`
    : `${label}时间 ${when}，还有约 ${mins} 分钟`;
  const added = {
    anchor, before: null, after: null,
    fireAt: new Date(now + 3000).toISOString(),
    text, catchup: true
  };
  return { list: [added], added };
}

function finalize(parsed) {
  const rule = ruleOf(parsed);
  // 「提醒我 X 分钟后…」：只要那一下，不套提前量模板
  if (parsed.remindOnly && parsed.remindAt) {
    const at = Date.parse(parsed.remindAt);
    if (Number.isFinite(at) && at > Date.now() - 60_000) {
      return {
        rule,
        planned: [{
          anchor: "remind", before: "0m", after: null,
          fireAt: new Date(at).toISOString(),
          text: parsed.reminderText || parsed.title || "提醒"
        }],
        immediate: false,
        expired: 0,
        skipped: []
      };
    }
  }
  const preview = rule ? expandReminders(parsed, rule) : { reminders: [], skipped: [] };
  const future = preview.reminders.filter(r => Date.parse(r.fireAt) > Date.now() - 60_000);
  const fixed = ensureImmediate(parsed, rule, future);
  return {
    rule,
    planned: fixed.list,
    immediate: Boolean(fixed.added),
    expired: preview.reminders.length - future.length,
    skipped: preview.skipped
  };
}

function modelInfo(m) {
  if (!m) return null;
  if (m.ok) {
    return {
      ok: true,
      model: m.model,
      latencyMs: m.latencyMs,
      usage: m.usage,
      cached: Boolean(m.cached),
      dropped: m.dropped || []
    };
  }
  return { ok: false, error: m.error, skipped: Boolean(m.skipped), reason: m.reason };
}

// 把模型结果并进规则结果。模型是主，规则补空；两边打架的地方一律写进 notes 让人看。
function mergeModel(ruleParsed, model) {
  const mp = model.parsed || {};
  const v = model.value || {};
  const notes = [];

  const byName = ruleBook.rules.find(r => r.name === mp.type)
    || ruleBook.rules.find(r => r.id === mp.type);
  const rule = byName || ruleBook.rules.find(r => r.isDefault)
    || { id: "other", name: "其他", reminders: [] };
  if (!byName && mp.type) notes.push(`模型判的类型「${mp.type}」不在规则目录里，按「${rule.name}」处理`);

  const anchors = {};
  for (const k of ["start", "end", "due"]) {
    const fromModel = v[k] || null;
    const fromRule = ruleParsed?.[k] || null;
    if (fromModel) {
      anchors[k] = fromModel;
      if (fromRule) {
        const gap = Math.abs(Date.parse(fromModel) - Date.parse(fromRule));
        if (gap > 5 * 60_000) {
          notes.push(`「${ANCHOR_LABEL[k]}」模型算的是 ${shortTime(fromModel)}，规则算的是 ${shortTime(fromRule)}，已采用模型的，请核对`);
        }
      }
    } else {
      anchors[k] = fromRule;
      if (fromRule) notes.push(`模型没认出「${ANCHOR_LABEL[k]}」时间，这一项用的是规则算的 ${shortTime(fromRule)}`);
    }
  }

  for (const d of model.dropped || []) notes.push(d.reason);
  for (const n of model.notes || []) notes.push(n);
  for (const n of (mp.notes || [])) if (n) notes.push(String(n));
  const uniq = [...new Set(notes)];

  const hasAnchor = Boolean(anchors.start || anchors.due);

  let conf = Number(mp.confidence);
  if (!Number.isFinite(conf) || conf <= 0 || conf > 1) conf = 0.75;
  if ((model.dropped || []).length) conf = Math.min(conf, 0.5);
  if (!hasAnchor) conf = Math.min(conf, 0.3);
  conf = Math.round(conf * 100) / 100;

  const title = String(mp.title || "").replace(/\s+/g, " ").trim().slice(0, 60)
    || ruleParsed?.title || "未命名事项";

  return {
    type: rule.id || rule.name,
    typeName: rule.name,
    ruleFile: rule.file || null,
    title,
    course: mp.course || ruleParsed?.course || null,
    start: anchors.start,
    end: anchors.end,
    due: anchors.due,
    // 「提醒我」是规则层判出来的，模型不管提醒策略，原样继承
    remindAt: ruleParsed?.remindOnly ? ruleParsed.remindAt : null,
    remindOnly: Boolean(ruleParsed?.remindOnly),
    reminderText: ruleParsed?.reminderText || null,
    durationMinutes: ruleParsed?.durationMinutes ?? null,
    location: mp.location || null,
    confidence: conf,
    needsInfo: !hasAnchor,
    notes: uniq,
    matchedKeywords: [],
    rawText: model.source || "",
    engine: "model",
    ruleGuess: ruleParsed ? {
      typeName: ruleParsed.typeName,
      start: ruleParsed.start, end: ruleParsed.end, due: ruleParsed.due,
      confidence: ruleParsed.confidence
    } : null
  };
}

// 主入口：先规则，不够把握再问模型。force = auto | always | never
async function analyze(text, { force = "auto" } = {}) {
  const rules = ruleBook.rules;
  const ruleParsed = parse(text, { rules });
  const cfg = llmConfig(config.llm);

  // 规则什么时候算「没把握」
  const weak = ruleParsed.confidence < 0.62
    || ruleParsed.needsInfo
    || (!ruleParsed.start && !ruleParsed.due)
    || !ruleParsed.matchedKeywords.length;

  let useModel = false;
  if (force === "always") useModel = true;
  else if (force === "never") useModel = false;
  else useModel = llmReady(cfg) && (cfg.mode === "always" || weak);

  if (!useModel) {
    return {
      parsed: { ...ruleParsed, engine: "rule" },
      engine: "rule",
      model: { ok: false, skipped: true, reason: force === "never" ? "这次指定不用模型" : llmReady(cfg) ? "规则已经够确定，没花这次钱" : "模型没启用" }
    };
  }

  if (!llmReady(cfg)) {
    return {
      parsed: { ...ruleParsed, engine: "rule" },
      engine: "rule",
      model: { ok: false, error: "想用模型，但还没配置 API Key（点右上角「模型」填一个）" }
    };
  }

  const m = await llmParse({ text, config: config.llm, rules });
  if (!m.ok) {
    // 模型挂了不能牵连规则的结果
    return { parsed: { ...ruleParsed, engine: "rule" }, engine: "rule", model: m };
  }
  return { parsed: mergeModel(ruleParsed, m), engine: "model", model: m };
}

// 手机 <input type="datetime-local"> 给的是 "2026-11-11T20:00" 这种没有时区的字符串。
// 服务器跑在 UTC，直接 Date.parse 会当成 UTC 解析，整体偏 8 小时——
// 用户设的「晚上八点」会变成第二天凌晨四点。没带时区就按北京时间补上。
function parsePointMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const at = Date.parse(hasZone ? s : s.replace(" ", "T") + "+08:00");
  return Number.isFinite(at) ? at : null;
}

// 用户单独指定的提醒点（「八点也提醒我一次」）。这些不受规则约束，
// 规则改了也不会把它们冲掉——它们存在任务上，和 start/end 一样是任务的一部分。
function customReminderPoints(task) {
  const out = [];
  for (const raw of task.extraReminders || []) {
    const iso = typeof raw === "string" ? raw : raw?.at;
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) continue;
    out.push({
      anchor: "custom",
      before: null,
      after: null,
      fireAt: new Date(at).toISOString(),
      text: (typeof raw === "object" && raw?.text) || task.title || "提醒"
    });
  }
  return out;
}

// 用户明确取消掉的时刻。规则算出来的点也能被压掉——
// 只说「18:45 那次别叫了」，不该动整条规则。
function mutedSet(task) {
  const set = new Set();
  for (const raw of task.mutedReminders || []) {
    const at = Date.parse(typeof raw === "string" ? raw : raw?.at || "");
    if (Number.isFinite(at)) set.add(at);
  }
  return set;
}

function rebuildReminders(task, rule) {
  const notes = [...(task.notes || [])];
  // 「提醒我」句式：那个时刻就是要响的时刻，别套提前量
  if (task.remindOnly && task.remindAt) {
    const at = Date.parse(task.remindAt);
    if (!Number.isFinite(at) || at <= Date.now() - 60_000) {
      notes.push("要提醒的那个时间已经过去了，没排提醒");
      return { created: 0, notes, expired: 1 };
    }
    store.addReminders(task.id, [{
      anchor: "remind", before: "0m", after: null,
      fireAt: new Date(at).toISOString(),
      text: task.reminderText || task.title || "提醒"
    }]);
    return { created: 1, notes, expired: 0 };
  }
  const { reminders, skipped } = expandReminders(task, rule);
  const muted = mutedSet(task);
  const now = Date.now();
  const future = [];
  const expired = [];
  const seen = new Set();
  // 规则排出来的点 + 用户自己加的点，同一时刻只留一条
  for (const r of [...reminders, ...customReminderPoints(task)]) {
    const at = Date.parse(r.fireAt);
    if (!Number.isFinite(at)) continue;
    if (muted.has(at) || seen.has(at)) continue;
    seen.add(at);
    if (at > now - 60_000) future.push(r);
    else if (r.anchor !== "custom") expired.push(r);   // 自定义点过期了静默丢弃，别拿它刷日志
  }
  future.sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  // 「提前的时点都过了就现在补一嗓子」这条兜底，用户亲手把点删光时不适用：
  // 他刚在手机上把这些提醒一个个点掉，再补一个「现在」等于没删。
  const fixed = (!future.length && muted.size)
    ? { list: [], added: null }
    : ensureImmediate(task, rule, future, now);
  store.addReminders(task.id, fixed.list);
  for (const e of expired) notes.push(`「${e.anchor === "due" ? "截止" : e.anchor === "end" ? "结束" : "开始"}前 ${e.before}」的时间点已经过去了，跳过`);
  for (const s of skipped) notes.push(`没排上 ${s.anchor} 的提醒：${s.reason}`);
  if (fixed.added) notes.push(`提前的时点都过了，改成现在先提醒一次：${fixed.added.text}`);
  return { created: fixed.list.length, notes, expired: expired.length };
}

// 已经识别好的结果，别再走一遍 analyze（模型要花钱的）
async function commitTask({ text, parsed, engine, source }) {
  const rule = ruleOf(parsed);
  const task = store.addTask({ ...parsed, raw: String(text || "").slice(0, 4000), source, engine });
  const built = rule
    ? rebuildReminders(task, rule)
    : { created: 0, notes: [...(parsed.notes || []), "规则目录是空的，这条没排上任何提醒"] };
  task.notes = built.notes;
  await store.flush();
  kickCloudSync("新任务");
  return { task, created: built.created, notes: built.notes };
}

// ---------- 自动抓取（剪贴板） ----------

const QQ_PROCS = new Set(["qq", "qqnt", "tim", "qqsclauncher"]);
const BROWSER_PROCS = new Set([
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "iexplore",
  "360se", "360chromex", "sogouexplorer", "qqbrowser", "liebao"
]);

const clipRecent = [];        // 处理过的内容指纹，防同一条重复触发
const clipLog = [];           // 给界面看的最近抓取记录
const pageSeen = new Map();   // 网页那边已经处理过的内容，避免重复入队

function fingerprint(s) {
  return String(s || "").replace(/\s+/g, "").slice(0, 220);
}

function rememberClip(fp) {
  clipRecent.push(fp);
  if (clipRecent.length > 40) clipRecent.shift();
}

function markPageSeen(text) {
  const fp = fingerprint(text);
  if (fp) pageSeen.set(fp, Date.now());
  if (pageSeen.size > 80) pageSeen.delete(pageSeen.keys().next().value);
}

function addClipLog(entry) {
  clipLog.unshift({ at: new Date().toISOString(), ...entry });
  if (clipLog.length > 12) clipLog.length = 12;
}

function addInboxEntry(entry) {
  const id = randomUUID().slice(0, 8);
  store.addInbox({ id, ...entry });
  return id;
}

// 图片：模型优先，模型不成退本地 OCR。返回 parsed 的话调用方直接能用。
async function readImage(b64, mime) {
  const cfg = llmConfig(config.llm);
  const wantModel = llmReady(cfg) && cfg.imageMode === "model";
  let modelFail = null;

  if (wantModel) {
    const r = await llmParse({ image: b64, mime, config: config.llm, rules: ruleBook.rules });
    if (r.ok) return { ok: true, engine: "model", text: r.source, parsed: mergeModel(null, r), model: r };
    modelFail = r;
    log("读图失败，退回本地 OCR：", r.error);
  }

  const tmp = workFile(`upload-${randomUUID()}.png`);
  await writeFile(tmp, Buffer.from(b64, "base64"));
  try {
    const r = await ocrImage(tmp);
    if (!r.ok) {
      return {
        ok: false,
        error: modelFail ? `${modelFail.error}；本地 OCR 也没成功：${r.error}` : (r.error || "识别失败"),
        model: modelFail
      };
    }
    return { ok: true, engine: "ocr", text: r.text, lines: r.lines, model: modelFail };
  } finally {
    unlink(tmp).catch(() => {});
  }
}

// 图片直接交给模型看——它本来就看得见图，不需要我们先转成一段文字再喂给它。
// 转述一次就丢一层：表情、语气、图上的小字、排版关系，全在那一步损失掉。
async function loadImageParts(images, max = 4) {
  const parts = [];
  for (const url of images.slice(0, max)) {
    const got = await fetchImage(url);
    if (!got.ok) { log("图片没下下来：", got.error); continue; }
    parts.push({
      type: "image_url",
      image_url: { url: `data:${got.mime};base64,${got.buf.toString("base64")}` }
    });
  }
  return parts;
}

async function handleClipboardEvent(ev) {
  if (ev.event === "error") { log("剪贴板出错：", ev.message); return; }
  if (ev.event !== "clip") return;

  const cfg = config.clipboard || CLIP_DEFAULTS;
  if (!cfg.enabled) return;

  const source = String(ev.source || "");
  const low = source.toLowerCase();
  const isQQ = QQ_PROCS.has(low);
  const isBrowser = BROWSER_PROCS.has(low);

  let text = "";
  let parsed = null;
  let engine = "rule";
  let model = null;

  if (ev.kind === "text") {
    text = String(ev.text || "").trim();
    if (text.length < 6) return;
    if (text.length > 4000) {
      addClipLog({ kind: "skip", source, reason: "内容太长，不像一条通知" });
      return;
    }
    const fp = fingerprint(text);
    if (clipRecent.includes(fp)) return;
    if (pageSeen.has(fp) && Date.now() - pageSeen.get(fp) < 20_000) return; // 网页那边刚处理过
    rememberClip(fp);

    if (cfg.onlyFromQQ && !isQQ) {
      addClipLog({ kind: "skip", source, reason: `不是从 QQ 复制的（当时前台是 ${source || "未知程序"}）` });
      return;
    }

    const r = await analyze(text);
    parsed = r.parsed;
    engine = r.engine;
    model = r.model;
  } else if (ev.kind === "image") {
    let buf;
    try {
      buf = await readFile(ev.path);
    } catch {
      addClipLog({ kind: "skip", source, reason: "图片临时文件读不到" });
      return;
    } finally {
      unlink(ev.path).catch(() => {});
    }
    if (buf.length > 12 * 1024 * 1024) {
      addClipLog({ kind: "skip", source, reason: `图片 ${(buf.length / 1048576).toFixed(1)} MB，太大了` });
      return;
    }
    const b64 = buf.toString("base64");
    const fp = fingerprint("img:" + b64.slice(0, 800) + b64.length);
    if (clipRecent.includes(fp)) return;
    rememberClip(fp);

    const r = await readImage(b64, "image/png");
    if (!r.ok) {
      addClipLog({ kind: "fail", source, reason: r.error });
      return;
    }
    if (r.parsed) {
      parsed = r.parsed;
      engine = r.engine;
      model = r.model;
      text = r.text || parsed.title || "";
    } else {
      text = String(r.text || "").trim();
      if (!text) {
        addClipLog({ kind: "fail", source, reason: "图片里没读出字" });
        return;
      }
      const r2 = await analyze(text);
      parsed = r2.parsed;
      engine = r2.engine;
      model = r2.model;
    }
  } else {
    return;
  }

  if (!parsed) return;

  const fin = finalize(parsed);
  const planned = fin.planned;
  const typed = Boolean(parsed.typeName) && parsed.typeName !== "其他";
  const rawText = text || "[图片]";
  const head = {
    source,
    engine,
    text: rawText,
    title: parsed.title || "未命名",
    typeName: parsed.typeName,
    model: modelInfo(model)
  };

  // 既没类型也没时间：当普通聊天放过，不打扰
  if (!typed && !planned.length) {
    addClipLog({ ...head, kind: "ignore", reason: "没匹配到任务类型、也没有时间，判为普通聊天" });
    return;
  }

  // 同一条内容两天内重复复制：直接跳过
  const fpText = fingerprint(rawText);
  const dup = store.tasks.find(t =>
    fingerprint(t.raw) === fpText && Date.now() - Date.parse(t.createdAt) < 48 * 3600_000);
  if (dup) {
    addClipLog({ ...head, kind: "skip", reason: `这条已经加过了（${shortTime(dup.createdAt)}）` });
    return;
  }

  const ask = !cfg.autoAdd || isBrowser || parsed.needsInfo || !planned.length;
  if (ask) {
    // 浏览器里复制的多半就是在本网页粘贴，别抢；缺时间的也别硬加
    const reason = isBrowser ? "从浏览器复制的，先放这儿等你确认"
      : (!cfg.autoAdd ? "自动加入已关闭，等你确认"
        : (!planned.length ? "没找到能排的时间" : "缺时间"));
    addInboxEntry({
      kind: "clip",
      title: `待确认：${parsed.title || "未命名"}`,
      body: `${reason}　·　${parsed.typeName || "其他"}　·　来自 ${source || "剪贴板"}`,
      text: rawText,
      source: source || "剪贴板",
      status: "pending"
    });
    addClipLog({ ...head, kind: "inbox", reason });
    return;
  }

  const { task, created } = await commitTask({
    text: rawText,
    parsed,
    engine,
    source: `自动·${source || "剪贴板"}`
  });
  const first = store.remindersOf(task.id).find(r => r.status === "pending");
  addClipLog({ ...head, kind: "added", reason: `排了 ${created} 条提醒` });
  await notify({
    title: `已加入：${task.title}`,
    body: first ? `第一条提醒 ${shortTime(first.fireAt)}（共 ${created} 条）` : `没排上提醒，去网页看看`,
    kind: "clip"
  });
}

const watcher = process.env.TODO_NO_WATCH
  ? { stop() {}, status: () => ({ running: false, ready: false, restarts: 0, off: true }) }
  : startClipboardWatcher({
    root: ROOT,
    log,
    onEvent: ev => { handleClipboardEvent(ev).catch(e => log("处理剪贴板失败：", e.message)); }
  });

// ---------- QQ 小号（NapCat / OneBot 反向上报） ----------

const ANCHOR_CN = { start: "开始", end: "结束", due: "截止" };
const qqSeen = new Set();
let qqPending = null;     // 认出类型但缺时间的那条，等下一条消息补时间
let lastQQ = null;        // 给界面看「最近收到什么」

// 消息水位：记录「已经处理到哪一条」。服务停机期间 NapCat 上报是直接丢弃的
// （ECONNREFUSED，不重试），所以再起来时要靠这个水位把漏掉的补回来。
//
// 注意：补处理的区间必须用「启动那一刻」的快照。实时消息一进来就会把水位推到
// 最新，如果补处理再拿当前水位当下限，停机期间那段就永远补不回来了。
const QQ_LAST_PATH = join(DATA, "qq-last.json");
let qqLastTime = 0;       // unix 秒，当前水位
try {
  qqLastTime = Number(JSON.parse(await readFile(QQ_LAST_PATH, "utf8")).lastTime) || 0;
} catch { /* 第一次运行，没有水位 */ }
const QQ_WATERMARK_AT_BOOT = qqLastTime;              // 本次启动时继承的水位（补处理下限）
const BOOT_AT = Math.floor(Date.now() / 1000);        // 启动时刻（补处理上限）

async function saveQQWatermark(t) {
  const v = Number(t) || 0;
  if (!v || v <= qqLastTime) return;
  qqLastTime = v;
  try { await writeFile(QQ_LAST_PATH, JSON.stringify({ lastTime: v }), "utf8"); } catch { /* 写不进去就算了 */ }
}

const taskWhen = t => Date.parse(t?.due || t?.start || t?.end || "") || 0;

function reminderLines(taskId) {
  return store.remindersOf(taskId)
    .filter(r => r.status === "pending")
    .map(r => `· ${shortTime(r.fireAt)}　${r.text}`)
    .join("\n");
}

function describeTask(task) {
  const anchors = ["start", "end", "due"]
    .filter(k => task[k])
    .map(k => `${ANCHOR_CN[k]} ${shortTime(task[k])}`)
    .join("　");
  const lines = [`已记下：${task.title}`, `${task.typeName}${anchors ? "　" + anchors : ""}`];
  const rem = reminderLines(task.id);
  lines.push(rem ? "会提醒你：\n" + rem : "但一条提醒都没排上，去网页看看。");
  return lines.join("\n");
}

// 认出但缺时间的情况：先入库（网页里能补），并记住它，等下一条消息带时间过来
async function acceptParsed({ parsed, engine, text, source }) {
  const fin = finalize(parsed);
  const typed = Boolean(parsed.typeName) && parsed.typeName !== "其他";
  if (!typed && !fin.planned.length) return { ok: false, reason: "没认出类型，也没有时间" };

  if (parsed.needsInfo || !fin.planned.length) {
    const { task } = await commitTask({ text, parsed, engine, source });
    qqPending = task.id;
    const why = !fin.planned.length ? "没找到能排提醒的时间" : "缺时间";
    return {
      ok: true,
      reply: `认出来了：${task.title}（${task.typeName}）\n但${why}。回一句具体时间我就补上，比如「11月10日 23:59」。`
    };
  }

  const { task, created } = await commitTask({ text, parsed, engine, source });
  qqPending = null;
  return { ok: true, reply: describeTask(task), task, created };
}

function statusText() {
  const open = store.tasks
    .map(t => ({ t, next: store.remindersOf(t.id).find(r => r.status === "pending") }))
    .filter(x => x.next || x.t.needsInfo)
    .sort((a, b) => taskWhen({ due: a.next?.fireAt }) - taskWhen({ due: b.next?.fireAt }))
    .slice(0, 12);
  if (!open.length) return "现在没有待办。";
  const lines = [`手上有 ${open.length} 条：`, ""];
  for (const { t, next } of open) {
    lines.push(`${t.id}　${t.title}`);
    lines.push(next ? `　下次提醒 ${shortTime(next.fireAt)}` : "　还缺时间");
  }
  lines.push("", "发「取消 编号」可以删掉某条。");
  return lines.join("\n");
}

const CN_NUM = "一二三四五六七八九十两";

// 「讲座取消了」「物理小测不去了」这类是在撤回已有待办，不是一条新通知。
// 只认整句以撤回词结尾的短消息，避免把「明天讲座取消后改到周五」这种真通知误判。
const CANCEL_TAIL = /^(.{1,20}?)\s*(取消了|已取消|取消|不去了|不开了|不用了|作废了|作废|删掉了|删掉|删除)$/;

function cancelIntent(text) {
  const s = String(text || "").trim().replace(/[，,。.！!～~\s]+$/g, "");
  if (!s || s.length > 26) return null;
  const m = CANCEL_TAIL.exec(s);
  if (!m) return null;
  const word = m[1].trim()
    .replace(/^(那个|这个|刚才那个|刚说的|刚才的)/, "")
    .replace(/[的了]$/, "");
  return word ? { word } : null;
}

function pickTaskByWord(word) {
  const pool = store.tasks.slice();
  if (!pool.length) return null;
  const norm = t => String(t.title || "").replace(/\s/g, "");
  const w = String(word).replace(/\s/g, "");

  let hit = pool.filter(t => norm(t) === w);
  if (!hit.length) hit = pool.filter(t => norm(t).includes(w) || w.includes(norm(t)));
  if (!hit.length) {
    const chars = [...new Set(w.split(""))];
    const need = Math.max(2, Math.ceil(chars.length * 0.6));
    hit = pool.filter(t => {
      const title = norm(t);
      return chars.filter(c => title.includes(c)).length >= need;
    });
  }
  if (!hit.length) return null;
  return hit.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}

// 有没有说出「具体几点」。只写「明天」「后天」不算，那种得再问一句。
function hasExplicitClock(text) {
  const s = String(text || "");
  return /\d{1,2}\s*[:：]\s*\d{1,2}/.test(s)
    || new RegExp(`[${CN_NUM}\\d]{1,3}\\s*[点时]`).test(s);
}

function looksLikeTimeOnly(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 40) return false;
  // 「明天的」这种没有数字，但全是时间词 —— 也得算时间碎片
  const hasDigit = new RegExp(`[${CN_NUM}\\d]`).test(s);
  const hasDayWord = /[今明后天下周星期周月日号]/.test(s);
  if (!hasDigit && !hasDayWord) return false;
  return new RegExp(`^[今明后天下周星期周月日号点分上午下午晚上早中半至到\\-~—:：.\\/\\s\\d${CN_NUM}的了吗呀啊]+$`).test(s);
}

// 兜底：类型认不出、也没说出具体几点、又短得离谱的，不要当待办入库。
function tooWeakToRecord(text, parsed, fin) {
  const s = String(text || "").trim();
  if (fin.planned.length) return false;
  if (parsed.typeName && parsed.typeName !== "其他") return false;
  if (hasExplicitClock(s)) return false;
  return (parsed.confidence ?? 0) < 0.4 || s.length <= 8;
}

// 模型给的 ISO 时间统一成 +08:00；格式不对就当没给
function modelTime(raw) {
  const s = String(raw || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss = "00"] = m;
  if (Number.isNaN(new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`).getTime())) return null;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`;
}

// 判意图。规则能一口咬定「这是一条完整通知」就直接放行，省一次模型调用；
// 剩下的（取消、补时间、碎片、闲聊）交给模型，模型不可用时退回本地正则。
async function qqIntent(text) {
  const rules = ruleBook.rules;
  const p = parse(text, { rules });
  const sure = p.confidence >= 0.62
    && p.matchedKeywords.length > 0
    && !p.needsInfo
    && Boolean(p.start || p.due || p.end);
  if (sure) return { ok: true, intent: "new_task", byRule: true };

  const pendingTask = qqPending ? store.tasks.find(t => t.id === qqPending) : null;
  const live = store.tasks.filter(t => !t.needsInfo
    || store.remindersOf(t.id).some(r => r.status === "pending"));

  const m = await llmIntent({
    text,
    tasks: live,
    pending: pendingTask ? pendingTask.title : null,
    config: config.llm
  });
  if (m.ok) {
    log(`意图判断：${m.intent}${m.target ? `（${m.target}）` : ""}，置信 ${(m.confidence || 0).toFixed(2)}`);
    return m;
  }

  log(`意图判断没走通（${m.error || m.code}），退回本地规则`);
  const ci = cancelIntent(text);
  if (ci) return { ok: true, intent: "cancel_task", target: ci.word, byRule: true, degraded: true };
  if (tooWeakToRecord(text, p, finalize(p))) {
    return { ok: true, intent: "chat", reply: "", byRule: true, degraded: true };
  }
  return { ok: true, intent: "new_task", byRule: true, degraded: true };
}

// ---------- QQ 模型助手：让模型当大脑，待办操作当工具 ----------
// 以前是「正则判意图 + 固定模板回复」，遇到「全部删除」这种就只能干瞪眼。
// 现在把增删改查暴露成工具，理解语义和开口说话都交给模型。

const QQ_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "查看当前所有待办和每条待办的提醒时间点。用户问「有什么待办」「状态」「还有啥」时调用。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "新建一条待办。用户提到任何要做的事、转发的通知、作业、考试、小测、会议、报名截止，都用这个。系统会按规则自动排提醒。一条消息里有多个事项就调用多次。",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "要记的完整内容。必须把相对时间换成具体日期，例如把「明天下午两点」改写成「11月5日下午两点」，其余信息原样保留"
          },
          type_hint: {
            type: "string",
            description: "类型提示：作业、考试、小测、会议、活动。拿不准就留空，系统会自己判断"
          }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "修改一条已有待办的时间、标题，或增删提醒点。用户说「八点也提醒我一次」「再加一个九点的提醒」「18:45 那次别叫了」都用这个，不要新建任务。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "要改哪一条，用关键词指代，例如「习题二」「高数作业」「12.5 的考试」" },
          start: { type: "string", description: "新的开始时间，写成 2026-11-05T14:30:00+08:00" },
          end: { type: "string", description: "新的结束时间，格式同上" },
          due: { type: "string", description: "新的截止时间，格式同上" },
          title: { type: "string", description: "要改成的新标题，不改就不填" },
          add_reminders: {
            type: "array",
            items: { type: "string" },
            description:
              "要额外加一个提醒时刻（绝对时间，不是提前量）。用户说「12.5 晚上八点也提醒我」就填 [\"2026-12-05T20:00:00+08:00\"]。注意「晚上八点」是 20:00，不是 08:00。"
          },
          remove_reminders: {
            type: "array",
            items: { type: "string" },
            description: "要取消的提醒时刻（绝对时间）。用户说「18:45 那次取消」就填 [\"2026-12-05T18:45:00+08:00\"]。"
          }
        },
        required: ["target"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_tasks",
      description: "删除待办。删一条用 target 指定；用户说「全部删除」「都删了」「清空」就传 all=true。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "要删哪一条，用关键词指代" },
          all: { type: "boolean", description: "是否删除全部待办" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "把一条待办标记为已完成（用户说「做完了」「交了」「已经搞定了」时用）",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "哪一条，用关键词指代" }
        },
        required: ["target"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_ics",
      description: "把待办提醒导出成 .ics 日历文件，直接发到主人的 QQ。主人说「要ics」「导出日历」「导到手机日历」「发我个日历文件」时用。文件到 QQ 里点开就能导入手机日历。",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "导出未来多少天的提醒。没特别说就填 14；说「这个月」「全都」可以填 30" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "上网搜索。被问到你不确定的具体事实时用：地名、单位、学校、村、某个人的公开信息、数据、价格、产品参数、最近发生的事。搜到再答，比凭记忆编强。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词。像人在搜索框里打的一样，别写整句话，把关键词堆在一起，例如「某某县某某村 邮编」" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "打开一个网页读正文。web_search 的结果里有看起来最相关的链接、但摘要不够用时，用它把那一页读下来。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的网址，必须来自搜索结果" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "往长期记忆里存一条。存的是「以后还用得上」的事实，不是聊天流水。\n值得存：主人是谁、在哪、上什么学、怎么称呼他、他讨厌什么；群里谁是谁、外号对应哪个真名；约定好的事、习惯、偏好；「记住…」「以后都…」这类明确要求。\n不值得存：一次性的问题、情绪、笑话、当下在聊什么、已经在待办里的时间安排（那个用 create_task）。\n判断标准就一句：一周后这条还有没有用。有就存，没有就别存。\n不要为了显得用心而滥存，记忆里塞满废话等于没有记忆。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "一句话说清这件事，像给自己写的备注，例如「主人住在某省某县，在读大学」「群里「昵称甲」就是张三」" },
          scope: { type: "string", description: "填 group 表示只在这个群有用（比如群里的外号、暗号）；填 global 或不填表示哪个场景都适用（比如关于主人的事）" },
          tag: { type: "string", description: "person 人物 / fact 事实 / pref 偏好 / plan 约定，不填就是 fact" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "删掉记忆里含某个关键词的条目。用户说「忘掉」「别记着」「那个不对」时用。",
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: "关键词，能从记忆原文里定位到就行，例如「张三」" }
        },
        required: ["match"]
      }
    }
  }
];

// 模型给的时间可能是 ISO，也可能是「11月5日下午两点」，两种都收
function coerceTime(raw) {
  const iso = modelTime(raw);
  if (iso) return iso;
  const s = String(raw || "").trim();
  if (!s) return null;
  const p = parse(s, { rules: ruleBook.rules });
  return p.start || p.due || p.end || null;
}

function taskBrief(task) {
  const rem = store.remindersOf(task.id)
    .filter(r => r.status === "pending")
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
    .map(r => `${shortTime(r.fireAt)} ${r.text}`);
  return {
    id: task.id,
    title: task.title,
    type: task.typeName,
    start: task.start || null,
    end: task.end || null,
    due: task.due || null,
    reminders: rem,
    notes: Array.isArray(task.notes) ? task.notes : []
  };
}

async function execQQTool(name, args, ctx = {}) {
  if (name === "list_tasks") {
    if (!store.tasks.length) return { ok: true, count: 0, tasks: [], hint: "现在没有任何待办" };
    return { ok: true, count: store.tasks.length, tasks: store.tasks.map(taskBrief) };
  }

  if (name === "create_task") {
    const content = String(args?.text || "").trim();
    if (!content) return { ok: false, error: "没给待办内容" };

    let parsed = parse(content, { rules: ruleBook.rules });
    let engine = "规则";
    // 规则认不出类型时再问模型解析（这一步本来就在，保留）
    if (!parsed.typeName || parsed.typeName === "其他") {
      const m = await llmParse({ text: content, config: config.llm });
      if (m.ok && m.parsed) { parsed = m.parsed; engine = "模型"; }
    }
    if (!parsed.typeName && args?.type_hint) parsed.typeName = String(args.type_hint);

    const fin = finalize(parsed);
    if (!parsed.typeName && !fin.planned.length) {
      return { ok: false, error: "没认出类型，也没算出时间，这条不像待办" };
    }

    // 同一件事别记两遍。模型在工具循环里有时会对同一条消息调两次 create_task
    // （实测出现过，一条消息变两条待办），用户也可能连着发两遍同一份通知。
    // 判据：时间完全一致，且标题一方包含另一方（入库标题会去掉时间词，不会完全相同）。
    const key = s => String(s || "").replace(/[\s，,。.、：:；;（）()【】\[\]「」"'’“”]/g, "").toLowerCase();
    const sameTime = t => String(t.start || "") === String(parsed.start || "")
      && String(t.due || "") === String(parsed.due || "")
      && String(t.end || "") === String(parsed.end || "");
    const dup = store.tasks.find(t => {
      if (!sameTime(t)) return false;
      const a = key(t.title), b = key(content);
      if (!a || !b) return false;
      return a === b || a.includes(b) || b.includes(a);
    });
    if (dup) return { ok: true, task: taskBrief(dup), duplicate: true, note: "这条已经记过，没有重复创建" };

    const { task } = await commitTask({ text: content, parsed, engine, source: "QQ小号" });
    qqPending = null;   // 模型自己会追问，不用本地挂起
    return { ok: true, task: taskBrief(task) };
  }

  if (name === "update_task") {
    const target = String(args?.target || "").trim();
    const hit = pickTaskByWord(target) || (store.tasks.length === 1 ? store.tasks[0] : null);
    if (!hit) return { ok: false, error: `没找到和「${target}」对得上的待办` };

    const changed = [];
    if (args?.title) { hit.title = String(args.title).trim(); changed.push("标题"); }
    for (const k of ["start", "end", "due"]) {
      if (!args?.[k]) continue;
      const t = coerceTime(args[k]);
      if (!t) return { ok: false, error: `「${args[k]}」这个时间没看懂` };
      hit[k] = t;
      changed.push(ANCHOR_CN[k]);
    }

    // 增删提醒点。加的点存进 extraReminders（跟着任务走，规则重排也不会丢），
    // 删的点存进 mutedReminders（连规则算出来的那次也能压掉）。
    const atOf = x => Date.parse(typeof x === "string" ? x : x?.at);
    if (Array.isArray(args?.add_reminders) && args.add_reminders.length) {
      const extra = [...(hit.extraReminders || [])];
      const muted = new Set((hit.mutedReminders || []).map(atOf).filter(Number.isFinite));
      for (const raw of args.add_reminders) {
        const t = coerceTime(raw);
        if (!t) return { ok: false, error: `「${raw}」这个时间没看懂` };
        const at = Date.parse(t);
        if (at <= Date.now() - 60_000) return { ok: false, error: `「${raw}」已经过去了，加不了提醒` };
        muted.delete(at);
        if (!extra.some(x => atOf(x) === at)) extra.push(t);
      }
      hit.extraReminders = extra;
      hit.mutedReminders = [...muted].map(ms => new Date(ms).toISOString());
      changed.push("提醒点");
    }
    if (Array.isArray(args?.remove_reminders) && args.remove_reminders.length) {
      const bad = args.remove_reminders.map(coerceTime).filter(t => !t);
      if (bad.length) return { ok: false, error: `「${bad[0]}」这个时间没看懂` };
      const drop = new Set(args.remove_reminders.map(r => Date.parse(coerceTime(r))));
      const muted = new Set((hit.mutedReminders || []).map(atOf).filter(Number.isFinite));
      for (const at of drop) muted.add(at);
      hit.extraReminders = (hit.extraReminders || []).filter(x => !drop.has(atOf(x)));
      hit.mutedReminders = [...muted].map(ms => new Date(ms).toISOString());
      changed.push("取消提醒");
    }

    if (!changed.length) return { ok: false, error: "没说要改什么" };

    hit.needsInfo = !hit.start && !hit.due;
    store.reminders = store.reminders.filter(r => r.taskId !== hit.id || r.status !== "pending");
    const rule = ruleOf(hit);
    const built = rule ? rebuildReminders(hit, rule) : { created: 0, notes: [] };
    hit.notes = built.notes;
    await store.flush();
    qqPending = null;
    return { ok: true, changed, task: taskBrief(hit) };
  }

  if (name === "delete_tasks") {
    if (args?.all) {
      const n = store.tasks.length;
      for (const t of [...store.tasks]) store.dropTask(t.id);
      await store.flush();
      if (qqPending && !store.tasks.some(t => t.id === qqPending)) qqPending = null;
      return { ok: true, deleted: n, all: true };
    }
    const target = String(args?.target || "").trim();
    const hit = pickTaskByWord(target);
    if (!hit) return { ok: false, error: `没找到和「${target}」对得上的待办` };
    if (qqPending === hit.id) qqPending = null;
    store.dropTask(hit.id);
    await store.flush();
    return { ok: true, deleted: 1, title: hit.title };
  }

  if (name === "complete_task") {
    const target = String(args?.target || "").trim();
    const hit = pickTaskByWord(target);
    if (!hit) return { ok: false, error: `没找到和「${target}」对得上的待办` };
    const title = hit.title;
    if (qqPending === hit.id) qqPending = null;
    store.dropTask(hit.id);   // 完成即从待办里摘掉，提醒也一并撤掉
    await store.flush();
    return { ok: true, done: 1, title };
  }

  if (name === "send_ics") {
    const r = await sendIcsToQQ(args?.days);
    if (!r.ok) {
      // 没有提醒时别说「发送失败」，说清是没东西可导
      return { ok: false, error: r.error, count: r.count || 0 };
    }
    return { ok: true, count: r.count, days: r.days, file: r.file, hint: "文件已经发到主人 QQ，告诉他点开就能导入手机日历" };
  }

  if (name === "web_search") {
    const q = String(args?.query || "").trim();
    if (!q) return { ok: false, error: "搜索词是空的" };
    // 优先走 DeepSeek 官方搜索接口（快、稳、摘要成段），拿不到就退回抓取引擎
    const r = await webSearch(q, { apiKey: config?.llm?.apiKey || "" });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, engine: r.engine, text: searchToText(r).slice(0, 2200) };
  }

  if (name === "fetch_url") {
    const url = String(args?.url || "").trim();
    if (!url) return { ok: false, error: "没给网址" };
    const p = await fetchPage(url, { apiKey: config?.llm?.apiKey || "" });
    if (!p.ok) return { ok: false, error: p.error };
    return { ok: true, title: p.title, url: p.url, text: p.text, truncated: p.truncated };
  }

  if (name === "remember") {
    const text = String(args?.text || "").trim();
    if (!text) return { ok: false, error: "没说要记什么" };
    // 群里的外号、暗号只在这个群有用；关于主人的事则到处都用得上。
    const wantsLocal = /group|群/i.test(String(args?.scope || ""));
    const scope = wantsLocal && ctx.gid ? `g:${ctx.gid}` : "*";
    const r = memory.add({ text, scope, tag: String(args?.tag || "fact"), by: String(ctx.from || "") });
    if (!r.ok) return r;
    await memory.save();
    return {
      ok: true,
      remembered: r.item.text,
      scope: scope === "*" ? "全局" : "只有这个群",
      dup: Boolean(r.dup),
      total: memory.count()
    };
  }

  if (name === "forget") {
    const r = memory.remove(args?.match);
    if (r.ok) await memory.save();
    return r;
  }

  return { ok: false, error: `没有这个工具：${name}` };
}

function nowLineCN() {
  const d = new Date(Date.now() + 8 * 3600_000);
  const w = ["日", "一", "二", "三", "四", "五", "六"][d.getUTCDay()];
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}（星期${w}，北京时间）`;
}

function qqSystemPrompt(taskList, scene = "private", opts = {}) {
  const lines = [
    "你是主人的私人待办助理，通过一个 QQ 小号和他单聊。主人是学生，经常把班级群通知、作业要求、考试安排转发给你。",
    "",
    `现在是 ${nowLineCN()}。`,
    "",
    "当前待办：",
    taskList,
    "",
    "你有这些工具：list_tasks 查待办、create_task 记待办、update_task 改时间或加/取消某次提醒、delete_tasks 删待办、complete_task 标记完成、send_ics 发日历文件、web_search 上网搜、fetch_url 打开网页读正文、remember 存长期记忆、forget 删记忆。",
    "",
    "怎么处理：",
    "1. 用户发来的任何「要做的事、通知、作业、考试、会议、截止日期」都要用 create_task 记下来。一条消息里有多件事就调用多次。",
    "2. 记之前先把相对时间换成具体日期（「明天」→ 11月5日，「下周三」→ 算清楚是哪天），用北京时间 UTC+8。",
    "3. 用户没说具体几点，不要自己编一个。先记下来，然后在回复里问一句就行。",
    "4. 用户说「全部删除」「都删了」「清空」→ delete_tasks 传 all=true，别只删一条。",
    "5. 用户补时间、改时间 → update_task，别新建一条。",
    "6. 用户只是聊天、抱怨、问别的事，正常回话，不要建待办。",
    "7. 用户问「现在有什么」「删了没」「还在不在」，先调 list_tasks 看真实列表再答，绝对不要凭上一轮的记忆说。",
    "",
    "【记忆：待办以外的人和事也要记住】",
    "你有一份长期记忆。用户消息最前面那段「【我记得的事】」不是他刚说的，是你以前自己记下的，可以当作已知事实用。",
    "出现下面这些就主动调 remember 存一条，别等人提醒：",
    "- 关于主人本人的稳定信息：名字、在哪、上什么学、做什么、怎么称呼他、他的习惯和喜好、他说过「以后都…」的约定；",
    "- 人物对应关系：群里谁的外号是谁、谁是谁、谁是主人的同学/朋友；",
    "- 主人明确说「记住」「记一下」「别忘了」——这种必须存，一条都不能漏。",
    "存成一句结论，不要复刻原话。例如「主人住在某省某县，在读大学」「群里那个「昵称甲」是张三，主人室友」。",
    "不要存：一次性的闲聊、情绪、玩笑、当下在聊什么、已经在待办里的时间安排（那个走 create_task）。判断标准就一句：一周后还用不用得上。",
    "主人说「忘掉」「别记着」「那条不对」→ 用 forget，match 给关键词。",
    "主人问「你还记得…吗」，以「【我记得的事】」为准：记着就直说，没记过就坦白说没记过、可以让他再说一遍。绝不编，也绝不说「我没有记忆功能」「我记不住」——你有记忆，就在上面那段里。",
    "",
    "【加提醒 / 取消提醒：用 update_task，不要新建任务，也不要说办不到】",
    "用户说「八点也提醒我一次」「再加个九点的」「18:45 那次别叫了」这类话时，指的是**已经记着的那件事**，用 update_task 传 add_reminders / remove_reminders，值是完整的绝对时间（如 2026-12-05T20:00:00+08:00）。",
    "这是能做的，系统里就有这个能力。绝对不要回答「办不到」「系统只能自动排」「只能再建一条」，也不要为了加一个提醒就复制出一条新待办——那样同一件事会有两条，主人很反感。",
    "时间说法要分清：「晚上八点」是 20:00，「早上八点」才是 08:00。用户说「12.5 晚上的考试」就是在说那场 19:00 开始的考试，别把它当成 12.5 早上 8 点的新事情。",
    "改完把最终排定的提醒时刻一条条列给他（几点几分），让他能核对。",
    "",
    "【你确实会发提醒——别把自己说成只能记事】",
    "这套东西是真的能到点叫你：你在 create_task 里定下的每个时间点，到那一刻系统会用你正跟主人说话的这个 QQ 号，给他发一条私聊消息。主人手机上收到的那条，就是提醒本身。",
    "所以主人问「你到底能不能提醒」时，答案是能。不是你「记下来让别人去发」，也不是「只能记录」——这条链路里你是发言的那一端。",
    "你现在跑在一台云服务器上（阿里云的 Ubuntu），24 小时开着，跟主人自己那台电脑一点关系都没有。他关机、出门、睡觉，都不影响你按时发提醒——只要服务器不停机、这个 QQ 号在线，提醒就会准时发出去。",
    "主人问「你是不是跑在云端」「我电脑关了还能提醒吗」这类问题时：直接答是，就说这台机器一直开着、不依赖他那台电脑。这是你能确定的事实，不要含糊，也不要说「我没法知道自己跑在哪」「我自己查不了」。",
    "唯一可能断的情况：这个 QQ 号被顶下线（比如拿同一个号在别处登录），那时候发不出去。恢复之后系统会回头补看掉线期间的消息，把漏掉的事补记回来，但已经过去的时间点补不回来。这属于少数情况，不用每次都主动讲，被问到了再说。",
    "主人追问延迟、没收到的时候：说清楚「我这边几点几分发的」，剩下的（手机锁屏、后台被清、QQ 推送延迟）确实不归你管，直接说这部分你查不到，一句话就够，别反复道歉，也别顺杆承认「那我等于没有提醒功能」——那是错的。",
    "",
    "【要日历文件就直接发文件，别让他自己复制】",
    "主人说「要 ics」「导出日历」「导到手机日历」「给我个日历文件」的时候，调 send_ics，把 .ics 文件直接发到他 QQ。文件到他手机上点开就能导入系统日历，那才是他要的东西。",
    "绝对不要：输出 BEGIN:VCALENDAR 那一大段让他自己复制保存。手机上照这个做几乎都会失败（存不成 .ics、或者存成 .txt），而且他问的本来就是「怎么才能生成」。",
    "也绝对不要说「我发不了文件」——你能发。send_ics 就是干这个的。",
    "发完告诉他：文件发过去了，QQ 里点开就能导入；顺便说清里面是哪些事、覆盖多少天。",
    "如果他说「怎么只有这几条」：日历里只放「未来这段时间还有提醒要发的事」，没定时间、没有提醒点的待办不会进去。这是设计如此，不是漏了。",
    "",
    "怎么说话：",
    "- 像朋友发微信一样，短、口语化。不要用「已记录至待办列表」这种机器腔，不要用 markdown 标题和加粗。",
    "- 记完待办用一两句话确认：说清是什么事、什么时候、什么时候提醒你。别把工具返回的字段原样念一遍。",
    "- 排不上提醒（比如没说结束时间）就顺口提一句，别当成错误报警。",
    "- 不要每次都解释你的能力范围，用户问什么就答什么。",
    "",
    "怎么才算答得好：",
    "- 能查的就去查。用户问待办、问时间、问删没删，你手上有工具，先查再说，别凭印象编一个答案。",
    "- 问到具体的事实——某个村、某个学校、某个单位、某个人的公开信息、某个数字、某个产品参数、最近发生的事——先 web_search。这些不在你的记忆里，凭印象答十次错八次。搜到的结果里有对口的链接、摘要又不够，就 fetch_url 把那一页读下来。",
    "- 搜索结果可能来自别的地方的同名实体（别的县也有个同名村），要看是不是同一个地方再开口。",
    "- 查不到、不知道，就直接说不知道，一句话带过。不要绕、不要猜、不要编个听起来合理的说法糊弄过去。",
    "- 说错了就一次改对：说明真实情况是什么、接下来怎么弄。别连着道歉两遍，也别反复「我刚才看错了」。",
    "- 用户抱怨、吐槽、发火的时候，先把他真正要的东西给他（事情记下了没有、提醒定在几点），再谈别的。不要先解释自己有多难。",
    "- 主人问建议、问「怎么办」「怎么安排」的时候，别只复述他的安排。给出你自己的判断：先做什么、大概花多久、哪个环节最容易出岔子。"
  ];

  if (scene === "group") {
    const forced = opts.reason === "at";
    lines.push(
      "",
      "【注意：你不在私聊，你在一个 QQ 群里旁听】",
      `群名：${opts.group || "某个群"}。你发的每句话，全群人都能看见。`,
      "",
      "最近群里说的话（旧的在上面）：",
      String(opts.ctx || "（群里还没人说话）"),
      "",
      forced
        ? "刚才这条是有人 @ 你，必须回应，不能装死。"
        : opts.reason === "chatty"
          ? "群里正在聊天。有人问到了你确实知道的事，就把话接住、答到位；纯闲聊或接不上，就别吭声。"
          : "刚才这条你也看到了。你可以选择不说话——接不上、没意义、纯闲聊，就不吭声，没人会怪你。",
      "",
      "什么时候该开口：",
      "- 有人问了具体问题，你知道、或者查一下就能查出来——这种必须答，而且答完整",
      "- 有人叫你的名字，或者明显在问你",
      "- 群里聊到主人要做的事、截止时间、安排，你能帮上忙",
      "- 有人说的东西是错的，你确定正确的说法是什么",
      "",
      "什么时候闭嘴：",
      "- 别人之间正常聊天、斗嘴、互相起哄",
      "- 只有一两个字、表情、语气词（「fw」「笑死」「6」「？」），接不出实际内容",
      "- 你只想附和一句「哈哈」「确实」「+1」",
      "- 你搜了也确实找不到，硬答只会答错",
      "",
      "【先查再答，别凭印象】",
      "你手上有 web_search 和 fetch_url 两个工具，真能上网搜。",
      "- 有人问到具体事实——某个村、某个学校、某条路、某个店、某个人、某个数据、某个产品参数、最近发生的事——先搜。这些不在你的记忆里，硬答就是编。",
      "- 搜索结果里摘要不够、或者看起来有对口的链接，就 fetch_url 把那一页读下来。要的是细节，别只抄一行摘要。",
      "- 同名的地方很多（好几个县都有同名的村子）。开口前先确认是不是同一个地方，别把隔壁县的资料当成这边的。",
      "- 查完再说话。别一边搜一边往外蹦半句，也别说「我查一下」然后没下文。",
      "- 搜不到就实话实说「我搜了下没找到」，别用想象填空。",
      "",
      "说话规矩：",
      "- 闲聊一两句就够。但别人认真问你一个具体问题（要名单、要阵容、要步骤、要哪个更好），就把答案给全，别为了显得随意把关键内容省掉——省掉了对方还是得再问一遍，那才是真的蠢。",
      "- 知道就具体说。问名字就报名字，问几个就是几个，问参数就报数字。别用「因人而异」「看情况」「这要看你怎么玩」糊过去。",
      "- 不知道就先搜，搜完还不知道就说不知道。绝对不要编一个听起来合理的答案。群里都是熟人，编一次以后没人信你。",
      "- 被人追问「你确定吗」「真的假的」时：想清楚自己到底知不知道。真知道就把理由说清楚（哪来的、为什么），只是猜的就直接承认刚才在猜。别一追问就改口，也别硬撑。",
      "- 别像客服，别用「已为您」「请问还有什么需要」。",
      "- QQ 不渲染 markdown：不要用 **加粗**、# 标题、``` 代码块，要强调就直接说。",
      "- 绝对不要提「待办」「提醒系统」「助手」「记录」这类词，别让人看出你是个工具。",
      "- 不要复述待办列表，不要透露主人的私人安排和个人信息。",
      "- 群里有人发图时，你是直接看着那张图说话的。",
      "  按图里真实的东西说（「这不就是个猫吗」「图里写着周五交」），绝对不要说看不见、加载不出来、让别描述给你听。",
      ...(opts.hasImage
        ? [
            "- 这一轮就有图。在你回复的最后单独写一行：<<图注：一两句话，说清图里是什么、上面写了什么字>>",
            "  这一行不会发给任何人，只是留给你以后回忆起这张图用。别在正文里提这行。"
          ]
        : []),
      forced && opts.fromOwner
        ? "- 这条是主人本人发的，帮他记事是你的本职，该记就记。"
        : "- 这条不是主人发的。可以聊天，但不能替他建待办、改待办、删待办——他让你记什么，就回「这个让主人自己发给我」。",
      "",
      "决定不说话，就整句只输出：<skip>"
    );
  }

  if (opts.catchUp) {
    lines.push(
      "",
      "【重要：这不是实时对话，是在补看你不在线期间收到的一批老消息】",
      "这些消息当时可能已经处理过了，现在只是回放一遍。所以：",
      "- 只把里面确实要做的事用 create_task 记下来，别的一概不管。",
      "- 老消息里的「删掉吧」「改成三点」「全部清空」这类指令，当时已经执行过了，现在绝对不要执行。",
      "- 不要回话，不要寒暄，不要解释。",
      "- 拿不准的事，宁可不记，也别乱记。"
    );
  }

  return lines.join("\n");
}

const QQ_CHAT_PATH = join(DATA, "qq-chat.json");
let qqChat = [];
try {
  const raw = JSON.parse(await readFile(QQ_CHAT_PATH, "utf8"));
  if (Array.isArray(raw)) qqChat = raw.filter(m => m?.role && m?.content);
} catch { /* 第一次跑 */ }

async function saveQQChat() {
  try { await writeFile(QQ_CHAT_PATH, JSON.stringify(qqChat.slice(-40)), "utf8"); } catch { /* 存不进去不影响对话 */ }
}

// 群里的话不走私聊历史：群上下文由 GROUP_CTX 每次现拼进 system prompt，
// 私聊那十几条老对话不该混进群聊语境。
async function runQQAgent(cfg, text, opts = {}) {
  const llm = llmConfig(config.llm);
  if (!llmReady(llm)) return { ok: false, code: "no-llm", error: "没有配置模型 API Key" };

  const scene = opts.scene || "private";
  const isGroup = scene === "group";

  const taskList = store.tasks.length
    ? store.tasks.slice(0, 20).map(t => `- ${t.title}｜${t.start || t.due || t.end || "还没时间"}｜编号 ${t.id}`).join("\n")
    : "（当前没有待办）";

  // 补处理时也不带私聊上下文：为了回放批处理这件事本身被历史上的「删掉吧」带偏。
  const history = isGroup || opts.catchUp ? [] : qqChat.slice(-20);

  // 非主人说话的时候只给它只读工具——嘴上说别改，不如物理上不让改。
  // 搜索也算只读：群里同学问个地名、学校、参数，正是最需要查的时候，不能不给。
  // 补处理历史消息时同理：只允许「看」和「新建」，删改一律不给。
  // 这些老消息当初已经执行过一次了，重放一遍再删一次是灾难（曾经把刚记的任务删光）。
  const READONLY = new Set(["list_tasks", "web_search", "fetch_url"]);
  const tools = isGroup && !opts.fromOwner
    ? QQ_TOOLS.filter(t => READONLY.has(t.function.name))
    : opts.catchUp
      ? QQ_TOOLS.filter(t => t.function.name === "list_tasks" || t.function.name === "create_task")
      : QQ_TOOLS;

  const images = opts.imageParts || [];

  // 记忆拼在 user 消息前面，不塞 system prompt。
  // 塞 system 会让提示词每轮都不一样，DeepSeek 的上下文缓存就再也命不中，
  // 每条消息都要按全价重算一遍前缀。放在 user 里，system + 历史那段前缀仍然稳定。
  const memScope = isGroup && opts.gid ? `g:${opts.gid}` : "*";
  const memBlock = opts.catchUp
    ? ""
    : memory.render({
        scope: memScope,
        // 群里不是主人说话时，只给这个群自己的记忆，把主人的私事挡在外面。
        includeGlobal: isGroup ? Boolean(opts.fromOwner) : true
      });
  const userText = memBlock ? `${memBlock}\n\n【这轮消息】\n${text}` : text;

  const userContent = images.length
    ? [...images, { type: "text", text: userText }]
    : userText;

  const messages = [
    { role: "system", content: qqSystemPrompt(taskList, scene, { ...opts, hasImage: images.length > 0 }) },
    ...history,
    { role: "user", content: userContent }
  ];

  const r = await runWithTools({
    cfg: llm,
    messages,
    tools,
    onToolCall: (name, args) => execQQTool(name, args, { scene, gid: opts.gid, from: opts.from }),
    onRound: (name, args) => log(`助手 → ${name} ${JSON.stringify(args || {}).slice(0, 140)}`),
    maxRounds: 5
  });

  if (!r.ok) return r;

  const replyText = String(r.reply || "").trim();

  if (!isGroup) {
    // 补处理回放时模型被要求别说话，空回复是正常结果，不算失败，也不进对话历史。
    if (!replyText && !opts.catchUp) return { ok: false, code: "empty-reply", error: "模型没说话" };
    if (replyText && !opts.catchUp) {
      qqChat.push({ role: "user", content: text }, { role: "assistant", content: replyText });
      qqChat = qqChat.slice(-40);
      await saveQQChat();
    }
  }

  return { ok: true, reply: replyText, rounds: r.rounds };
}

async function handleQQContent(cfg, text, images, opts = {}) {
  // 补处理历史消息时全程静默：只把该记的记下来，不逐条回话。
  // 这些是老消息，逐条回一遍就是刷屏（曾经一次重放 43 条，主人手机上连着响）。
  const silent = Boolean(opts.silent);
  const catchUp = Boolean(opts.catchUp);
  const reply = t => silent
    ? Promise.resolve({ ok: true, skipped: true })
    : sendPrivate(cfg, t).then(r => {
        // 回复内容也要留痕：以前只在收消息时记一行，出了问题只能靠用户截图，
        // 想核对「它到底答了什么」还得去翻 QQ 聊天记录。
        if (r.ok) log(`已回复：${String(t || "").replace(/\s+/g, " ").slice(0, 60)}`);
        else log("回 QQ 消息失败：", r.error);
        return r;
      });

  // ---------- 先让模型接管 ----------
  // 图片原样交给模型（它自己看得见），模型自己决定调哪个工具、怎么回话。
  // 模型不可用（没配 key / 超时 / 网络挂了）才落到下面那套规则流程。
  const imageParts = await loadImageParts(images);
  const content = String(text || "").trim() || (imageParts.length ? "看看这张图。" : "");

  if (!content && images.length) return reply("图没下来，可能是网络问题，再发一次试试。");

  if (content && !/^(帮助|help|怎么用|指令)$/i.test(content)) {
    const r = await runQQAgent(cfg, content, { imageParts, catchUp });
    if (r.ok && r.reply) return reply(r.reply);
    log(`模型助手没走通（${r.error || r.code}），退回规则流程`);
  }

  if (/^(帮助|help|怎么用|指令)$/i.test(text)) {
    return reply([
      "把群通知转发给我就行：文字、截图、多选合并转发都认。",
      "",
      "「状态」——看还有哪些待办",
      "「取消 3f2a」——删掉某条（编号在状态里）",
      "认不出时间时，直接回一句时间，我给你补上。"
    ].join("\n"));
  }

  if (/^(状态|列表|待办)$/.test(text)) return reply(statusText());

  const cancel = /^(取消|删除)\s*([0-9a-z]{2,8})$/i.exec(text);
  if (cancel) {
    const want = cancel[2].toLowerCase();
    const hit = store.tasks.find(t => t.id.toLowerCase().startsWith(want));
    if (!hit) return reply(`没找到编号 ${want} 的任务，发「状态」看看有哪些。`);
    store.dropTask(hit.id);
    await store.flush();
    return reply(`删了：${hit.title}`);
  }

  if (!text && !images.length) return reply("这条我没看懂，转一条文字或截图给我？");

  // 补充时间：正在等补、且这条是纯时间碎片 → 本地直接处理。
  // 这条路比问模型快得多，也更准（模型容易把「明天的」判成一条新任务）。
  if (qqPending && !images.length && looksLikeTimeOnly(text)) {
    const task = store.tasks.find(t => t.id === qqPending);
    // 只说了「明天」没说几点 → 别硬塞一个默认 9:00，再问一句
    if (task && !hasExplicitClock(text)) {
      return reply(`「${text}」还缺几点，回一句「${text.replace(/[的呀啊]$/, "")}下午3点」这样的就行。`);
    }
    if (task) {
      const p = parse(text, { rules: ruleBook.rules });
      const when = p.start || p.due || p.end;
      if (when) {
        const anchor = task.typeName === "作业" ? "due" : "start";
        task[anchor] = when;
        task.needsInfo = !task.start && !task.due;
        store.reminders = store.reminders.filter(r => r.taskId !== task.id || r.status !== "pending");
        const rule = ruleOf(task);
        const built = rule ? rebuildReminders(task, rule) : { created: 0, notes: [] };
        task.notes = built.notes;
        await store.flush();
        qqPending = null;
        return reply(describeTask(task));
      }
    }
  }

  // 文字消息判意图：新建、撤回、复杂补时间，还是压根不是通知。
  // 规则能一口咬定是完整通知的就不花钱，其余交给模型。
  if (text && !images.length) {
    const it = await qqIntent(text);

    if (it.intent === "query") return reply(statusText());

    if (it.intent === "cancel_task" || it.intent === "complete_task") {
      // 模型没给 target 时，用本地正则从「XX取消了」里抠出主语
      const word = it.target || cancelIntent(text)?.word || text;
      const hit = pickTaskByWord(word) || pickTaskByWord(text);
      if (!hit) {
        return reply(`没找到「${word}」这条待办。发「状态」看看手上有哪些。`);
      }
      const n = store.remindersOf(hit.id).filter(r => r.status === "pending").length;
      if (qqPending === hit.id) qqPending = null;
      store.dropTask(hit.id);
      await store.flush();
      const verb = it.intent === "complete_task" ? "已完成" : "已取消";
      return reply(`${verb}：${hit.title}${n ? `，${n} 条提醒一并撤掉` : ""}。`);
    }

    if (it.intent === "supplement_time") {
      const task = qqPending ? store.tasks.find(t => t.id === qqPending) : null;
      if (task) {
        // 原文没说几点就再问一句，别让模型替我们「猜」一个 9:00 出来
        const clock = hasExplicitClock(text);
        const p = clock ? parse(text, { rules: ruleBook.rules }) : null;
        const when = clock ? (modelTime(it.time) || p.start || p.due || p.end || null) : null;
        if (!when) {
          return reply(`「${text}」还缺几点，回一句「明天下午3点」这样的就行。`);
        }
        const anchor = task.typeName === "作业" ? "due" : "start";
        task[anchor] = when;
        task.needsInfo = !task.start && !task.due;
        store.reminders = store.reminders.filter(r => r.taskId !== task.id || r.status !== "pending");
        const rule = ruleOf(task);
        const built = rule ? rebuildReminders(task, rule) : { created: 0, notes: [] };
        task.notes = built.notes;
        await store.flush();
        qqPending = null;
        return reply(describeTask(task));
      }
      // 没有在等补时间的，就按一条新通知继续往下走
    }

    if (it.intent === "chat") {
      return reply(it.reply || "这条看着不像通知，先没记。把完整通知原文转给我更准。");
    }
  }

  qqPending = null;

  if (images.length) {
    const out = [];
    for (const url of images.slice(0, 4)) {
      const got = await fetchImage(url);
      if (!got.ok) { out.push(`有张图没下下来：${got.error}`); continue; }
      const r = await readImage(got.buf.toString("base64"), got.mime);
      if (!r.ok) { out.push(`有张图没认出来：${r.error}`); continue; }
      let parsed = r.parsed;
      let engine = r.engine;
      if (!parsed) {
        const r2 = await analyze(r.text);
        parsed = r2.parsed;
        engine = r2.engine;
      }
      const res = await acceptParsed({ parsed, engine, text: r.text || text || "[图片]", source: "QQ小号" });
      out.push(res.ok ? res.reply : "这张图里没看出待办。");
    }
    return reply(out.join("\n\n"));
  }

  const r = await analyze(text);
  const fin = finalize(r.parsed);
  if (tooWeakToRecord(text, r.parsed, fin)) {
    return reply("这条看着不像通知（没认出类型，也没说出具体几点），先没记。\n把完整通知原文转给我更准。");
  }
  const res = await acceptParsed({ parsed: r.parsed, engine: r.engine, text, source: "QQ小号" });
  return reply(res.ok ? res.reply : "这条看着不像通知（没认出类型，也没有时间），先没记。");
}

// ---------- 群消息：常驻群里，自己判断要不要接话 ----------
// 每条群消息都进上下文窗口（这样它开口时能接上前面的话），
// 但「要不要真的说话」先由本地粗筛一遍，绝大多数消息不会进模型、也不花钱。
const GROUP_NAMES = new Map();
const GROUP_CTX = new Map();    // gid -> [{ who, text }]，最近 80 条
const GROUP_CTX_PATH = join(DATA, "group-ctx.json");
const GROUP_CTX_KEEP_MS = 6 * 3600_000;

// 群聊上下文以前只活在内存里，服务一重启（改配置、发版、机器重启）前情就全没了，
// 于是它接着说话就像失忆。现在落盘，重启后先把最近 6 小时接上。
try {
  const raw = JSON.parse(await readFile(GROUP_CTX_PATH, "utf8"));
  const cut = Date.now() - GROUP_CTX_KEEP_MS;
  for (const [gid, arr] of Object.entries(raw || {})) {
    if (!Array.isArray(arr)) continue;
    const keep = arr.filter(m => m && Number(m.at) > cut && m.text).slice(-80);
    if (keep.length) GROUP_CTX.set(String(gid), keep);
  }
  if (GROUP_CTX.size) {
    const n = [...GROUP_CTX.values()].reduce((a, b) => a + b.length, 0);
    log(`群聊上下文已恢复：${GROUP_CTX.size} 个群，共 ${n} 条`);
  }
} catch { /* 第一次跑 */ }

// 群里说话很密，每次都写盘太费；攒两秒写一次就够了。
let ctxSaveTimer = null;
function saveGroupCtxSoon() {
  if (ctxSaveTimer) return;
  ctxSaveTimer = setTimeout(async () => {
    ctxSaveTimer = null;
    try {
      const cut = Date.now() - GROUP_CTX_KEEP_MS;
      const obj = {};
      for (const [gid, arr] of GROUP_CTX) {
        const keep = arr.filter(m => Number(m.at) > cut).slice(-80);
        if (keep.length) obj[gid] = keep;
      }
      await writeFile(GROUP_CTX_PATH, JSON.stringify(obj), "utf8");
    } catch { /* 存不进去不该影响说话 */ }
  }, 2000);
  ctxSaveTimer.unref?.();
}
const GROUP_SPEAK = new Map();  // gid -> { last, hourStart, hourCount }
const SKIP_RE = /^[<（(【\[]?\s*(skip|不说|跳过|沉默|不回复|不说话)\s*[>）)】\]]?$/i;

// 群里的「我不说话」标记。模型整句只输出这个才算数，别误伤正常回复。
function isSkip(text) {
  return SKIP_RE.test(String(text || "").trim());
}

async function groupName(cfg, gid) {
  const hit = GROUP_NAMES.get(gid);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  const r = await groupList(cfg);
  if (r.ok && Array.isArray(r.data)) {
    const at = Date.now();
    for (const g of r.data) {
      GROUP_NAMES.set(String(g.group_id), { name: g.group_name || "", at });
    }
  }
  const name = GROUP_NAMES.get(gid)?.name || `群${gid}`;
  GROUP_NAMES.set(gid, { name, at: Date.now() });
  return name;
}

function ctxPush(gid, item) {
  const arr = GROUP_CTX.get(gid) || [];
  arr.push({ at: Date.now(), ...item });
  GROUP_CTX.set(gid, arr.slice(-80));
  if (GROUP_CTX.size > 120) GROUP_CTX.delete(GROUP_CTX.keys().next().value);
  saveGroupCtxSoon();
}

// 群里发的图，认一次就记住：同一个 url 十分钟内不重复花钱。
const GROUP_IMG = new Map();   // url -> { text, at }

async function describeGroupImage(url, hint) {
  const hit = GROUP_IMG.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;

  const got = await fetchImage(url);
  if (!got.ok) { log("群里图片没下来：", got.error); return ""; }

  const r = await llmDescribeImage({
    image: got.buf.toString("base64"),
    mime: got.mime,
    config: config.llm,
    hint: String(hint || "").slice(0, 60)
  });
  const text = r.ok ? String(r.text || "").trim().slice(0, 600) : "";
  if (!text) log("群里图片没认出来：", r.error || "空");
  else log(`群里图片看懂了（${r.cached ? "缓存" : `${r.latencyMs}ms`}）：${text.slice(0, 60)}`);

  GROUP_IMG.set(url, { text, at: Date.now() });
  if (GROUP_IMG.size > 200) GROUP_IMG.delete(GROUP_IMG.keys().next().value);
  return text;
}

// 挑出「这个群最近还没看过的图」。图不在这里转文字——原图直接交给模型，
// 它自己会看。只有模型没留图注（比如它选择不说话）时，才退回描述一次。
function collectFreshGroupImages(gid, max = 3) {
  const arr = GROUP_CTX.get(gid) || [];
  const cutoff = Date.now() - 15 * 60_000;
  const out = [];
  for (let i = arr.length - 1; i >= 0 && out.length < max; i--) {
    const m = arr[i];
    if (!m?.images?.length || m.imgDone) continue;
    if (m.at && m.at < cutoff) { m.imgDone = true; m.images = []; continue; }
    out.push({ entry: m, url: m.images[0], who: m.who });
  }
  return out;   // 最新的在前
}

// 模型回复里那行 <<图注：…>> 摘出来，正文不带它，图注留给以后的自己看。
function takeCaption(reply, fresh) {
  const re = /<<\s*图注[：:]\s*([\s\S]*?)\s*>>/;
  const m = re.exec(String(reply || ""));
  const caption = m ? m[1].replace(/\s+/g, " ").trim().slice(0, 300) : "";
  let clean = String(reply || "").replace(re, "").trim();
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();
  for (const f of fresh) { f.entry.imgDone = true; f.entry.images = []; }
  if (caption) {
    for (const f of fresh) {
      const head = !f.entry.text || f.entry.text === "[图片]" ? "" : `${f.entry.text} `;
      f.entry.text = `${head}[图片：${caption}]`.trim();
    }
  }
  return { reply: clean, caption };
}

function ctxText(gid, limit = 25) {
  const arr = GROUP_CTX.get(gid) || [];
  if (!arr.length) return "（群里还没人说话）";
  return arr.slice(-limit)
    .map(m => `${m.who}：${String(m.text).replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
}

// 本地粗筛。连「值不值得问模型」都过不了的，直接不出声。
function speakReason(cfg, { at, text, images }) {
  if (at) return "at";
  const mode = cfg.groupMode || "smart";
  if (mode === "silent") return null;

  const t = String(text || "").trim();
  const bare = t.replace(/[!！。.~～?？\s]+$/, "");

  // 有人往群里发图，一定要看一眼。图里没配文字也算——不然自拍、截图、
  // 表情包全都被当成「没信息量的空消息」扔掉，它就成了瞎子。
  if (images?.length) return "chatty";

  if (mode === "chatty") {
    // 聊天模式：正常说的话都交给模型判断。只把「没信息量」的挡在门外，
    // 纯附和、单字、光发表情这些让模型看纯属浪费。
    if (!bare) return null;
    if (bare.length < 2) return null;
    if (/^(收到|好的?|嗯+|哦+|ok|okay|1+|666+|哈哈+|谢谢|辛苦了|早|晚安)$/i.test(bare)) return null;
    return "chatty";
  }

  // smart
  if (!t) return null;
  if (t.length < 2) return null;
  if (/^(收到|好的?|嗯+|哦+|ok|okay|1+|666+|哈哈+|谢谢|辛苦了|早|晚安|收到收到|在吗)$/i.test(bare)) return null;
  if (/[?？]|怎么|为什么|为啥|啥意思|是不是|能不能|有没有|谁知道|问一下|有人知道/.test(t)) return "ask";
  const names = [String(cfg.botName || ""), ...(cfg.botAlias || [])].filter(n => n.length >= 2);
  if (names.some(n => t.includes(n))) return "name";
  return null;
}

// 说话闸门：主动插嘴有冷却和每小时上限；被 @ 不受限（人找你不能不吭声）。
// 冷却或上限设成 0 = 不限制（用户可以要求完全不限）。
function speakGate(cfg, gid, forced) {
  const now = Date.now();
  const st = GROUP_SPEAK.get(gid) || { last: 0, hourStart: now, hourCount: 0 };
  if (now - st.hourStart > 3600_000) { st.hourStart = now; st.hourCount = 0; }
  if (!forced) {
    const cd = Number(cfg.groupCooldownMs) || 0;
    const cap = Number(cfg.groupMaxPerHour) || 0;
    if (cd > 0 && st.last && now - st.last < cd) {
      const left = Math.round((cd - (now - st.last)) / 1000);
      return { ok: false, why: `冷却中，还剩 ${left} 秒` };
    }
    if (cap > 0 && st.hourCount >= cap) return { ok: false, why: "这小时说够了" };
  }
  GROUP_SPEAK.set(gid, st);
  return { ok: true };
}

function noteSpoke(cfg, gid) {
  const now = Date.now();
  const st = GROUP_SPEAK.get(gid) || { last: 0, hourStart: now, hourCount: 0 };
  if (now - st.hourStart > 3600_000) { st.hourStart = now; st.hourCount = 0; }
  st.last = now;
  st.hourCount += 1;
  GROUP_SPEAK.set(gid, st);
  if (GROUP_SPEAK.size > 120) GROUP_SPEAK.delete(GROUP_SPEAK.keys().next().value);
}

async function handleGroupMessage(cfg, ev) {
  const gid = String(ev.group_id || "");
  const from = String(ev.user_id || "");
  if (!gid || !cfg.bot) return;
  if (from && from === cfg.bot) return;               // 自己说的不接，免得自问自答

  const allow = cfg.groups || [];
  if (allow.length && !allow.includes(gid)) return;   // 填了白名单就只管那几个群

  const mid = String(ev.message_id ?? ev.message_seq ?? "");
  if (mid) {
    if (qqSeen.has(mid)) return;
    qqSeen.add(mid);
    if (qqSeen.size > 400) qqSeen.delete(qqSeen.values().next().value);
  }

  const { text, images } = await readMessage(cfg, ev.message, 0, { gid });
  const who = String(ev.sender?.card || ev.sender?.nickname || from || "");
  const at = atTarget(ev, cfg.bot);

  // 先记账：谁说了什么，全都进上下文。这是它能「接上前面的话」的前提。
  const body = String(text || "").trim() || (images.length ? "[图片]" : "");
  if (body) ctxPush(gid, { who, text: body, from, images });

  const reason = speakReason(cfg, { at, text, images });
  if (!reason) return;

  // 不当场回：攒 1.2 秒再一次性看。群里连着发五条，就只问一次模型，
  // 上下文里五条都在，回复也更像「听完了再说」，还省了四倍的钱。
  queueGroupTalk(cfg, gid, reason);
}

// ---------- 群聊发言调度：同群去抖 + 串行 ----------
const GROUP_DEBOUNCE_MS = 1200;
const GROUP_TALK_TIMER = new Map();   // gid -> timer
const GROUP_RUNNING = new Set();      // 正在调模型的群
const GROUP_QUEUED = new Map();       // gid -> 攒着的最强理由
const GROUP_RANK = { at: 3, name: 2, ask: 1, chatty: 0 };

function queueGroupTalk(cfg, gid, reason) {
  const prev = GROUP_QUEUED.get(gid);
  if (!prev || (GROUP_RANK[reason] ?? 0) > (GROUP_RANK[prev] ?? 0)) GROUP_QUEUED.set(gid, reason);
  if (GROUP_TALK_TIMER.has(gid)) return;            // 已经在攒，等这批一起看

  const timer = setTimeout(() => {
    GROUP_TALK_TIMER.delete(gid);
    const why = GROUP_QUEUED.get(gid) || reason;
    GROUP_QUEUED.delete(gid);
    runGroupTalk(cfg, gid, why).catch(e => log("群里接话出错：", e.message));
  }, GROUP_DEBOUNCE_MS);
  GROUP_TALK_TIMER.set(gid, timer);
}

async function runGroupTalk(cfg, gid, reason) {
  if (GROUP_RUNNING.has(gid)) {                     // 上一轮还在说，说完它会自己再看一眼
    GROUP_QUEUED.set(gid, reason);
    return;
  }
  GROUP_RUNNING.add(gid);
  try {
    const gate = speakGate(cfg, gid, reason === "at");
    if (!gate.ok) { log(`群里${gate.why}，不接话`); return; }

    const arr = GROUP_CTX.get(gid) || [];
    const last = [...arr].reverse().find(m => m.who !== "你");
    if (!last) return;

    const gname = await groupName(cfg, gid);

    // 最近的图直接原样交给模型，不再先转成文字。它自己看得见，而且
    // 表情、语气、图上那些小字，转述一遍就丢了。
    const fresh = collectFreshGroupImages(gid, 3);
    const imageParts = fresh.length ? await loadImageParts(fresh.map(f => f.url), 3) : [];

    const content = (last.text && last.text !== "[图片]") ? last.text : (imageParts.length ? "看看这张图。" : "");
    if (!content) return;

    log(`群里接话（${reason}，${imageParts.length} 张图）：${gname} / ${last.who}：${content.slice(0, 40)}`);

    const r = await runQQAgent(cfg, content, {
      scene: "group", group: gname, reason, gid,
      from: last.from, fromOwner: last.from === cfg.owner,
      ctx: ctxText(gid), imageParts
    });

    if (!r.ok) {
      log(`群里回话没走通（${r.error || r.code}）`);
      if (reason === "at") await sendGroup(cfg, gid, "脑子卡了一下，等我缓缓。");
      return;
    }

    const took = takeCaption(String(r.reply || ""), fresh);
    let reply = took.reply;

    // 它这一轮什么都没说（或者没留图注）→ 单独描述一次把图记住，
    // 不然下句「刚那张图是什么」它又成了瞎子。
    if (!took.caption && fresh.length) {
      const desc = await describeGroupImage(fresh[0].url, content === "看看这张图。" ? "" : content);
      if (desc) for (const f of fresh) {
        const head = !f.entry.text || f.entry.text === "[图片]" ? "" : `${f.entry.text} `;
        f.entry.text = `${head}[图片：${desc}]`.trim();
      }
    }

    if (!reply || isSkip(reply)) { log("群里看了，不说话"); return; }

    const sent = await sendGroup(cfg, gid, reply);
    if (!sent.ok) { log("群里回话失败：", sent.error); return; }
    noteSpoke(cfg, gid);
    ctxPush(gid, { who: "你", text: reply });        // 自己说的也记上，下次才知道自己说过啥
  } finally {
    GROUP_RUNNING.delete(gid);
    if (GROUP_QUEUED.has(gid)) {                     // 说话期间又有人聊，补看一眼（只补一次）
      const again = GROUP_QUEUED.get(gid);
      GROUP_QUEUED.delete(gid);
      setTimeout(() => runGroupTalk(cfg, gid, again).catch(() => {}), 800);
    }
  }
}

// 私聊消息必须一条一条处理。上报接口收到就返回 204，处理是异步的，
// 主人连发两条时两条会并发跑：后一条的回复先到，前一条的回复后到，
// 看起来就是「问 A 答成 B 的答案」，还带着错位的对话历史，越聊越乱（实测踩过）。
let privateChain = Promise.resolve();
function enqueuePrivate(fn) {
  const next = privateChain.then(fn).catch(e => log("处理私聊消息出错：", e.message));
  // 链不能因为某条失败就断掉，所以 catch 挂在 next 上而不是赋值给它
  privateChain = next.catch(() => {});
  return next;
}

async function handleOneBot(ev, headers, query) {
  const cfg = qqConfig(config.qq);
  if (!cfg.enabled) return;

  const given = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim()
    || String(query.get("token") || "").trim();
  if (cfg.token && given && given !== cfg.token) {
    log("QQ 上报的令牌不对，已忽略");
    return;
  }

  if (ev?.post_type !== "message") return;

  // 只服务私聊的部署（config.qq.privateOnly）：群消息进来直接丢掉，连解析都不做。
  // 为什么做成硬开关，而不是只靠 groupMode=silent —— silent 只是「不主动说话」，
  // 事件照样被解析、拉群成员名片、写群上下文，等于还在碰群。
  // 2026-11-07 13:36 群里连发两条，30 秒后就被踢，群聊是风控最敏感的场景之一。
  if (config.qq?.privateOnly === true && ev.message_type === "group") return;

  if (ev.message_type === "group") return handleGroupMessage(cfg, ev);

  if (ev.message_type !== "private") {
    log(`收到 ${ev.message_type} 类型的消息，跳过`);
    return;
  }
  const from = String(ev.user_id || "");
  if (from !== cfg.owner) {
    log(`收到 ${from} 的私聊，不是主人号，不理`);
    return;
  }

  const mid = String(ev.message_id ?? ev.message_seq ?? "");
  if (mid) {
    if (qqSeen.has(mid)) return;
    qqSeen.add(mid);
    if (qqSeen.size > 400) qqSeen.delete(qqSeen.values().next().value);
  }

  // 读取和处理都塞进串行队列：前一条没处理完，后一条不许开始
  return enqueuePrivate(async () => {
    const { text, images } = await readMessage(cfg, ev.message);
    lastQQ = { at: new Date().toISOString(), text: (text || "[图片]").slice(0, 200), images: images.length };
    log(`QQ 收到${images.length ? `${images.length} 张图` + (text ? " + 文字" : "") : "文字"}：${(text || "").slice(0, 40)}`);
    await saveQQWatermark(Number(ev.time) || Math.floor(Date.now() / 1000));
    await handleQQContent(cfg, text, images);
  });
}
// ---------- 补处理：NapCat 上报失败时被丢掉的那些消息 ----------
// 服务不在线 → NapCat POST 到 3790 拿到 ECONNREFUSED → 这条消息就没了，不重试。
// 所以每次起来先往回翻一遍，把水位（qq-last.json）之后的消息重新走一遍流程。

let catchingUp = false;
// 手动指定补处理下限（复验链路时用）。0 表示按启动时的水位快照算。
let catchFloorOverride = 0;

async function catchUpQQ({ quiet = false, dry = false } = {}) {
  const cfg = qqConfig(config.qq);
  if (!cfg.enabled) return { ok: false, skipped: true, error: "QQ 没开" };
  if (catchingUp) return { ok: false, skipped: true, error: "正在补" };
  catchingUp = true;
  try {
    // 100 是 NapCat 这个接口单次返回的上限，翻页（message_seq）在实测里不起作用，
    // 所以能补的就这么多：下线期间消息超过 100 条时，更早的那部分补不回来。
    const r = await friendHistory(cfg, cfg.owner, 100);
    if (!r.ok) return { ok: false, error: r.error };

    const raw = r.data;
    const list = Array.isArray(raw) ? raw : (raw?.messages || []);
    const now = Math.floor(Date.now() / 1000);
    // 下限：启动时继承的水位（第一次跑没有水位，只回看最近 20 分钟）。
    // 原来这里还夹了个「最多回看 12 小时」，等于关机超过半天就补不回来；
    // 现在只保留 30 天的安全垫，真正决定边界的是水位。
    const floor = catchFloorOverride
      ? catchFloorOverride
      : (QQ_WATERMARK_AT_BOOT
        ? Math.max(QQ_WATERMARK_AT_BOOT, now - 30 * 24 * 3600)
        : now - 20 * 60);
    // 上限：取「这次补处理开始」的时刻，而不是进程启动时刻。
    // NapCat 常常比服务晚起来（要扫码登录），中间这段时间的消息时间戳会晚于启动时刻，
    // 用 BOOT_AT 当上限就会把它们漏掉。重复处理由 qqSeen 按 message_id 拦住。
    const ceiling = now;

    const pending = list
      .map(m => ({ m, t: Number(m?.time) || 0 }))
      .filter(x => x.t > floor && x.t <= ceiling)
      .filter(x => String(x.m?.sender?.user_id ?? x.m?.user_id ?? "") === cfg.owner)
      .sort((a, b) => a.t - b.t);

    // 只看不办：返回「理论上会补哪几条」，不动水位、不建任务。
    // 复验补漏链路时用这个，免得为了测试把老消息重新记一遍待办。
    if (dry) {
      const unseen = pending.filter(({ m }) => {
        const mid = String(m.message_id ?? m.message_seq ?? "");
        return !mid || !qqSeen.has(mid);
      });
      return {
        ok: true,
        dry: true,
        scanned: list.length,
        count: unseen.length,
        from: new Date(floor * 1000).toISOString(),
        to: new Date(ceiling * 1000).toISOString(),
        items: unseen.slice(-20).map(({ m, t }) => ({
          at: new Date(t * 1000).toISOString(),
          id: String(m.message_id ?? m.message_seq ?? ""),
          preview: String(m.raw_message || "").replace(/\s+/g, " ").slice(0, 60)
        }))
      };
    }

    if (!pending.length) {
      // 没东西可补也要把水位推上去，免得下次重启又从头扫一遍同样的窗口
      await saveQQWatermark(ceiling);
      return { ok: true, count: 0, scanned: list.length };
    }

    log(`补处理：找到 ${pending.length} 条漏掉的消息`);
    const beforeIds = new Set(store.tasks.map(t => t.id));
    let done = 0;
    for (const { m, t } of pending) {
      const mid = String(m.message_id ?? m.message_seq ?? "");
      if (mid && qqSeen.has(mid)) continue;
      if (mid) {
        qqSeen.add(mid);
        if (qqSeen.size > 400) qqSeen.delete(qqSeen.values().next().value);
      }
      const { text, images } = await readMessage(cfg, m.message);
      if (!text && !images.length) continue;
      lastQQ = { at: new Date().toISOString(), text: (text || "[图片]").slice(0, 200), images: images.length };
      log(`补处理一条：${(text || "[图片]").slice(0, 40)}`);
      // 静默 + 只许新建：老消息里的「删掉吧」「改成几点」当初已经执行过，
      // 重放时再执行一遍会把现在的待办删掉、改乱。
      await handleQQContent(cfg, text, images, { silent: true, catchUp: true });
      await saveQQWatermark(t);
      done++;
    }
    // 推到这次补处理的结束时刻
    await saveQQWatermark(ceiling);
    const added = store.tasks.filter(t => !beforeIds.has(t.id));
    if (done && !quiet) {
      // 只说「补了 N 条」等于没说。把真正记下来的事念一遍，主人才知道该检查什么。
      await sendPrivate(cfg, added.length
        ? `我不在线时收到 ${done} 条消息，从中记下了：\n` +
          added.map(t => `· ${t.title}${t.start || t.due ? `（${new Date(t.start || t.due).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）` : ""}`).join("\n")
        : `补看了 ${done} 条我不在线时收到的消息，没有需要记的事。`);
    }
    return { ok: true, count: done, added: added.map(t => t.title), scanned: list.length };
  } finally {
    catchingUp = false;
    catchFloorOverride = 0;
  }
}

function publicQQConfig(cfg) {
  return {
    enabled: cfg.enabled,
    api: cfg.api,
    owner: cfg.owner,
    bot: cfg.bot,
    groups: cfg.groups || [],
    groupMode: cfg.groupMode || "smart",
    groupCooldownMs: cfg.groupCooldownMs,
    groupMaxPerHour: cfg.groupMaxPerHour,
    botAlias: cfg.botAlias || [],
    hasToken: Boolean(cfg.token),
    tokenHint: cfg.token ? `…${cfg.token.slice(-4)}` : ""
  };
}

function stateSnapshot() {
  const now = Date.now();
  return {
    now: new Date(now).toISOString(),
    tasks: store.tasks.map(t => ({ ...t, reminders: store.remindersOf(t.id) })),
    pending: store.reminders.filter(r => r.status === "pending").length,
    inbox: store.inbox.slice(-30).reverse(),
    rules: ruleBook.rules.map(r => ({ file: r.file, name: r.name, priority: r.priority, match: r.match, reminders: r.reminders })),
    ruleError: ruleBook.error,
    config: {
      webhook: { ...config.webhook, token: config.webhook.token ? "已填写" : "" },
      llm: publicLlmConfig(llmConfig(config.llm)),
      qq: publicQQConfig(qqConfig(config.qq)),
      clipboard: { ...CLIP_DEFAULTS, ...(config.clipboard || {}) }
    },
    clipStatus: { ...watcher.status(), lastQQ },
    clipLog,
    next: scheduler.next()
  };
}

const server = http.createServer(handleRequest);

// 最后一道保险。这是个自用服务，跑在手机背后的唯一的进程上：
// 一个随手写错的分支把它带走，用户那边就是"网页打不开"，而且没有任何提示。
// 记下来、继续跑，比干净地退出有用得多。
process.on("uncaughtException", err => {
  log("未捕获异常（服务继续跑）：", err?.stack || err?.message || err);
});
process.on("unhandledRejection", err => {
  log("未处理的 Promise 拒绝（服务继续跑）：", err?.stack || err?.message || err);
});

// 手机端：同一套处理逻辑，但只放行白名单路由，并且每个请求都要密钥。
// 单独开一个监听是为了不影响本机 3790 —— 那边是给自己电脑用的，不该要 token。
const MOBILE_ALLOW = new Set(["/m", "/todo.apk", "/api/state", "/api/add", "/api/share", "/api/photo", "/api/parse", "/api/calendar.ics", "/api/calendar.json", "/api/mobile/undo", "/api/mobile/reminders"]);

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const html = await readFile(join(ROOT, "public", "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (path === "/favicon.ico") { res.writeHead(204); return res.end(); }

    // 手机页。没有独立数据，全靠 JS 调下面的接口，所以这里只发文件。
    if (req.method === "GET" && path === "/m") {
      const html = await readFile(join(ROOT, "public", "m.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    // 手机装 App 用。跟手机页放同一个地址：手机上点一下就能下，
    // 不用再往微信/网盘里倒一遍。
    if (req.method === "GET" && path === "/todo.apk") {
      try {
        const buf = await readFile(join(ROOT, "public", "todo.apk"));
        res.writeHead(200, {
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Length": buf.length,
          "Content-Disposition": 'attachment; filename="todo.apk"',
          "Cache-Control": "no-cache"
        });
        return res.end(buf);
      } catch {
        return send(res, 404, "还没打包 APK", "text/plain; charset=utf-8");
      }
    }

    // 手机上标记完成 / 删除。放这里而不是复用桌面接口，是因为公网侧只放行白名单，
    // 多开一个口子就多一份风险。
    if (req.method === "POST" && (path === "/api/mobile/done" || path === "/api/mobile/drop")) {
      const { id } = await readBody(req);
      const task = store.tasks.find(t => t.id === id);
      if (!task) return send(res, 404, { error: "找不到这条了" });
      if (path.endsWith("/drop")) {
        store.dropTask(id);
        store.reminders = store.reminders.filter(r => r.taskId !== id);
      } else {
        task.done = true;
        task.doneAt = Date.now();
        for (const r of store.reminders) {
          if (r.taskId === id && r.status === "pending") r.status = "muted";
        }
      }
      await store.flush();
      log(`手机端${path.endsWith("/drop") ? "删除" : "完成"}了任务：`, task.title);
      return send(res, 200, { ok: true });
    }

    // 点错了要能退回来。完成时只是把提醒「静音」而不是删掉，
    // 所以恢复就是把还没过的那些重新点亮 —— 时间点保持原样，不用重算规则。
    if (req.method === "POST" && path === "/api/mobile/undo") {
      const { id } = await readBody(req);
      const task = store.tasks.find(t => t.id === id);
      if (!task) return send(res, 404, { error: "找不到这条了" });
      task.done = false;
      delete task.doneAt;
      const now = Date.now();
      let back = 0;
      for (const r of store.reminders) {
        if (r.taskId !== id || r.status !== "muted") continue;
        if (Date.parse(r.fireAt) > now) { r.status = "pending"; back++; }
      }
      await store.flush();
      log("手机端恢复了任务：", task.title, `（重新排上 ${back} 个提醒）`);
      return send(res, 200, { ok: true, restored: back });
    }

    // 手机上调整提醒时间。发过来的是「我最终想要的那几个时刻」，服务端反推出
    // 两种底层标记：规则本来不会排的点进 extraReminders（额外加），规则会排、
    // 但用户删掉的进 mutedReminders（只压掉那一次）。
    // 不整份覆盖任务 —— 原本自动排好的固定提醒只要用户没删就原样留着，
    // 规则以后改了也还能继续跟进，只是那几次被点掉的不再冒出来。
    if (req.method === "POST" && path === "/api/mobile/reminders") {
      const body = await readBody(req);
      const task = store.tasks.find(t => t.id === body.id);
      if (!task) return send(res, 404, { error: "找不到这条了" });

      if (body.mode === "auto") {
        delete task.extraReminders;
        delete task.mutedReminders;
      } else {
        const want = new Set();
        for (const raw of Array.isArray(body.points) ? body.points : []) {
          const at = parsePointMs(raw);
          if (at !== null) want.add(at);
        }

        // 规则自己会排哪些点（不含用户手动加的）。拿它当基准，才能算出
        // 「哪几个是用户额外要的」「哪几个是用户亲手删掉的」。
        const auto = new Set();
        if (task.remindOnly && task.remindAt) {
          const at = parsePointMs(task.remindAt);
          if (at !== null) auto.add(at);
        } else {
          const rule0 = ruleOf(task);
          if (rule0) {
            for (const r of expandReminders(task, rule0).reminders) {
              const at = Date.parse(r.fireAt);
              if (Number.isFinite(at)) auto.add(at);
            }
          }
        }

        const extra = [...want].filter(at => !auto.has(at)).sort((a, b) => a - b);
        const muted = [...auto].filter(at => !want.has(at));
        task.extraReminders = extra.map(at => new Date(at).toISOString());
        task.mutedReminders = muted.map(at => new Date(at).toISOString());
        if (!task.extraReminders.length) delete task.extraReminders;
        if (!task.mutedReminders.length) delete task.mutedReminders;

        // 「提醒我八点」这类只有单点的任务，一改就得改走 extra/muted，
        // 否则 rebuildReminders 永远走 remindOnly 分支，把用户的改动全忽略。
        if (task.remindOnly) {
          delete task.remindOnly;
          delete task.remindAt;
          delete task.reminderText;
        }
      }

      store.reminders = store.reminders.filter(r => r.taskId !== task.id || r.status !== "pending");
      const rule = ruleOf(task);
      if (rule) {
        const built = rebuildReminders(task, rule);
        task.notes = built.notes;
      } else {
        // 没有匹配规则的任务（「只发了作业」多半是这种），也要能只按用户给的点排
        const muted = mutedSet(task);
        const now = Date.now();
        const list = customReminderPoints(task)
          .filter(r => !muted.has(Date.parse(r.fireAt)) && Date.parse(r.fireAt) > now - 60_000);
        store.addReminders(task.id, list);
      }
      await store.flush();

      const now = Date.now();
      const live = store.remindersOf(task.id)
        .filter(r => r.status === "pending" && Date.parse(r.fireAt) > now - 60_000);
      log("手机端改了提醒时间：", task.title, `（共 ${live.length} 个点）`);
      return send(res, 200, {
        ok: true,
        manual: !!(task.extraReminders || task.mutedReminders),
        reminders: live.map(r => ({ fireAt: r.fireAt }))
      });
    }

    if (req.method === "GET" && path === "/api/calendar.ics") {
      const url = new URL(req.url, "http://127.0.0.1");
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
      const ics = buildIcs(calendarEvents(days), { name: "待办提醒" });
      res.writeHead(200, {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="todo-${new Date().toISOString().slice(0, 10)}.ics"`,
        "cache-control": "no-store"
      });
      return res.end(ics);
    }

    // 同样的日历内容，但给 App 用的 JSON。
    // 手机上那条 .ics 链接基本等于没用：安卓系统日历不认 http://IP:6099 这种订阅，
    // 多数机型也没有"导入 ics"的入口。App 拿着这份数据直接往系统日历里写事件，
    // 才是"手机日历里真能看到"的做法。
    if (req.method === "GET" && path === "/api/calendar.json") {
      const url = new URL(req.url, "http://127.0.0.1");
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 60));
      const events = calendarEvents(days).map(e => ({
        uid: e.uid,
        title: e.title,
        body: e.body || "",
        at: e.at,
        end: e.end || null,
        alarms: e.alarms || []
      }));
      return send(res, 200, { events });
    }

    // 把日历直接发到手机 QQ，省得用户自己去翻文件
    if (req.method === "POST" && path === "/api/calendar/send") {
      const body = await readBody(req);
      const r = await sendIcsToQQ(Number(body.days) || 14);
      return send(res, 200, r);
    }

    if (req.method === "GET" && path === "/api/state") return send(res, 200, stateSnapshot());

    // NapCat 的「HTTP 上报」指到这里。先回 204 再处理，
    // 免得识别慢（模型要几秒）让 NapCat 以为超时而重推同一条。
    if (req.method === "POST" && path === "/api/onebot") {
      const body = await readBody(req);
      send(res, 204, "");
      handleOneBot(body, req.headers, url.searchParams)
        .catch(e => log("处理 QQ 消息出错：", e.message));
      return;
    }

    // 手动补一次：NapCat 刚上线、或者想确认「开机补漏」到底管不管用时点这个
    if (req.method === "POST" && path === "/api/qq-catchup") {
      const body = await readBody(req);
      const isDry = Boolean(body.dry);
      // reset=true：把下限拉回到指定时间（或 24 小时前），用来复验补漏链路。
      // 只有真跑（非 dry）才允许改水位 —— dry 写盘会把水位退回去，
      // 下一次重启就会把老消息全部重新处理一遍（踩过这个坑）。
      if (body.reset && !isDry) {
        const back = Number(body.reset) > 0 ? Number(body.reset) : 24 * 3600;
        const t = Math.floor(Date.now() / 1000) - back;
        // 直接写盘：saveQQWatermark 只会把水位往前推，不会往回退
        try { await writeFile(QQ_LAST_PATH, JSON.stringify({ lastTime: t }), "utf8"); } catch { /* 写不进去也继续 */ }
        catchFloorOverride = t;
      } else if (body.reset && isDry) {
        const back = Number(body.reset) > 0 ? Number(body.reset) : 24 * 3600;
        catchFloorOverride = Math.floor(Date.now() / 1000) - back;
      }
      const r = await catchUpQQ({ dry: isDry });
      return send(res, 200, { ...r, watermark: qqLastTime });
    }

    // 只测连接，不存配置
    if (req.method === "POST" && path === "/api/qq-probe") {
      const body = await readBody(req);
      const cfg = qqConfig({ ...config.qq, ...(body.qq || {}) });
      if (body.qq?.token === undefined || body.qq?.token === "") cfg.token = config.qq?.token || "";
      const r = await qqProbe(cfg);
      return send(res, 200, r);
    }

    if (req.method === "POST" && path === "/api/parse") {
      const { text, force } = await readBody(req);
      const { parsed, engine, model } = await analyze(text, { force });
      const fin = finalize(parsed);
      return send(res, 200, {
        parsed,
        engine,
        planned: fin.planned,
        expired: fin.expired,
        skipped: fin.skipped,
        model: modelInfo(model)
      });
    }

    if (req.method === "POST" && path === "/api/add") {
      const { text, source = "粘贴" } = await readBody(req);
      markPageSeen(text);
      const { parsed, engine } = await analyze(text);
      const r = await commitTask({ text, parsed, engine, source });
      return send(res, 200, { ...r, engine });
    }

    // 系统分享面板进来的文本（QQ/微信里长按一条消息 → 分享 → 选「待办」）。
    // 返回**纯文本**两行，手机那边直接 Toast 弹出来，所以别塞 JSON、别塞表情。
    // 分享来的往往是一整段群通知，原样交给 analyze，规则不认就让模型读。
    if (req.method === "POST" && path === "/api/share") {
      const raw = (await readRaw(req)).trim();
      if (!raw) return send(res, 400, "内容是空的", "text/plain; charset=utf-8");
      const text = raw.slice(0, 2000);
      markPageSeen(text);
      const { parsed, engine } = await analyze(text);
      const r = await commitTask({ text, parsed, engine, source: "分享" });
      const title = cleanTitle(r.task?.title || text);
      const when = (store.remindersOf(r.task.id) || [])
        .filter(x => x.status === "pending")
        .sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt));
      const body = when.length
        ? `记下了：${title}\n会提醒：${briefTimes(when)}`
        : `记下了：${title}\n（没识别到时间，不会提醒）`;
      return send(res, 200, body, "text/plain; charset=utf-8");
    }

    // 手机拍照直接落库。跟 /api/ocr 的差别只有一点：识完就存，不再让用户核对一遍。
    // 手机上一张图往往就是一条通知，拍完还得点「保存」纯属折腾；
    // 万一认歪了，列表里一眼能看见，删掉比多点一次便宜。
    if (req.method === "POST" && path === "/api/photo") {
      const { dataUrl } = await readBody(req);
      const m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
      if (!m) return send(res, 400, { ok: false, error: "不是有效的图片数据" });
      const mime = m[1].toLowerCase();
      const b64 = m[2].replace(/\s+/g, "");
      const bytes = Buffer.from(b64, "base64");
      if (!bytes.length) return send(res, 200, { ok: false, error: "图片是空的" });
      if (bytes.length > 12 * 1024 * 1024) {
        return send(res, 200, { ok: false, error: "图片太大了（上限 12 MB），只截通知那一块再试" });
      }

      const r = await readImage(b64, mime);
      if (!r.ok) return send(res, 200, { ok: false, error: r.error });
      const text = String(r.text || "").trim();
      if (!text) return send(res, 200, { ok: false, error: "图里没读出字，换个角度或把通知放大再拍" });
      markPageSeen(text);

      // 模型直接读懂了就不用再解析一遍；退回 OCR 的路径才补一次文本分析
      let parsed = r.parsed;
      let engine = "model";
      if (!parsed) {
        const a = await analyze(text);
        parsed = a.parsed;
        engine = a.engine === "model" ? "model" : "ocr";
      }
      const done = await commitTask({ text, parsed, engine, source: "拍照" });
      return send(res, 200, { ok: true, engine, text, ...done });
    }

    // 图片入口。默认让模型直接看（小字、卡片、表格都比 OCR 准）；
    // 模型没配或失败，就退回系统 OCR，保证这条路永远不断。
    if (req.method === "POST" && path === "/api/ocr") {
      const { dataUrl } = await readBody(req);
      const m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
      if (!m) return send(res, 400, { error: "不是有效的图片数据" });
      const mime = m[1].toLowerCase();
      const b64 = m[2].replace(/\s+/g, "");
      const bytes = Buffer.from(b64, "base64");
      const MB = 1024 * 1024;
      if (!bytes.length) return send(res, 200, { ok: false, error: "图片是空的" });
      if (bytes.length > 12 * MB) {
        return send(res, 200, { ok: false, error: `图片 ${(bytes.length / MB).toFixed(1)} MB，太大了（上限 12 MB）。只截通知那一块再试` });
      }

      const r = await readImage(b64, mime);
      if (!r.ok) return send(res, 200, { ok: false, error: r.error, model: r.model ? modelInfo(r.model) : null });

      if (r.parsed) {
        const fin = finalize(r.parsed);
        return send(res, 200, {
          ok: true,
          engine: "model",
          text: r.text,
          parsed: r.parsed,
          planned: fin.planned,
          expired: fin.expired,
          skipped: fin.skipped,
          model: modelInfo(r.model)
        });
      }
      markPageSeen(r.text);
      return send(res, 200, {
        ok: true,
        engine: "ocr",
        text: r.text,
        lines: r.lines,
        model: r.model ? modelInfo(r.model) : null
      });
    }

    // 只测不存：把表单里的值拼到当前配置上试一次，不动磁盘
    if (req.method === "POST" && path === "/api/llm-probe") {
      const body = await readBody(req);
      const cfg = { ...(config.llm || {}), ...(body.llm || {}) };
      if (body.llm?.apiKey === undefined) cfg.apiKey = config.llm?.apiKey || "";
      const r = await llmProbe(cfg);
      return send(res, 200, r);
    }

    const taskTime = /^\/api\/task\/([\w-]+)\/time$/.exec(path);
    if (req.method === "POST" && taskTime) {
      const { anchor, value } = await readBody(req);
      const task = store.tasks.find(t => t.id === taskTime[1]);
      if (!task) return send(res, 404, { error: "没找到这条任务" });
      if (!["start", "end", "due"].includes(anchor)) return send(res, 400, { error: "锚点不对" });
      const wall = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
      if (!wall) return send(res, 400, { error: "时间格式不对，应是 2026-11-10T14:00" });
      task[anchor] = iso({ y: +wall[1], m: +wall[2], d: +wall[3], hh: +wall[4], mm: +wall[5] });
      task.needsInfo = !task.start && !task.due;
      store.reminders = store.reminders.filter(r => r.taskId !== task.id || r.status !== "pending");
      const rule = ruleOf(task);
      const built = rule ? rebuildReminders(task, rule) : { created: 0, notes: [] };
      task.notes = built.notes;
      await store.flush();
      return send(res, 200, { task, created: built.created, notes: built.notes });
    }

    const taskDelete = /^\/api\/task\/([\w-]+)$/.exec(path);
    if (req.method === "DELETE" && taskDelete) {
      store.dropTask(taskDelete[1]);
      await store.flush();
      return send(res, 200, { ok: true });
    }

    const remAction = /^\/api\/reminder\/([\w-]+)\/(skip|send)$/.exec(path);
    if (req.method === "POST" && remAction) {
      const r = store.reminders.find(x => x.id === remAction[1]);
      if (!r) return send(res, 404, { error: "没找到这条提醒" });
      if (remAction[2] === "skip") {
        store.markReminder(r.id, "skipped");
        await store.flush();
        return send(res, 200, { ok: true });
      }
      await scheduler.fire(r);
      return send(res, 200, { ok: true });
    }

    const ruleFile = /^\/api\/rules\/(.+\.json)$/.exec(path);
    if (req.method === "POST" && ruleFile) {
      const saved = await ruleBook.save(decodeURIComponent(ruleFile[1]), await readBody(req));
      return send(res, 200, { ok: true, rule: saved });
    }

    if (req.method === "POST" && path === "/api/reload-rules") {
      await ruleBook.load();
      return send(res, 200, { ok: true, rules: ruleBook.rules.length, error: ruleBook.error });
    }

    // 规则文件改过之后，把已有任务的提醒点按新规则重排一遍。
    // 只动还没完成的；用户自己加的点（extraReminders）和取消掉的点（mutedReminders）
    // 都由 rebuildReminders 原样带上，不会被规则冲掉。
    if (req.method === "POST" && path === "/api/replan") {
      const out = [];
      for (const task of store.tasks) {
        if (task.done) continue;
        const rule = ruleOf(task);
        if (!rule) continue;
        store.reminders = store.reminders.filter(r => r.taskId !== task.id || r.status !== "pending");
        const built = rebuildReminders(task, rule);
        task.notes = built.notes;
        out.push({ id: task.id.slice(0, 6), title: (task.title || "").slice(0, 30), created: built.created });
      }
      await store.flush();
      return send(res, 200, { ok: true, tasks: out });
    }

    if (req.method === "POST" && path === "/api/config") {
      const cfg = await saveConfig(await readBody(req));
      return send(res, 200, {
        ok: true,
        config: {
          webhook: { ...cfg.webhook, token: cfg.webhook.token ? "已填写" : "" },
          llm: publicLlmConfig(llmConfig(cfg.llm)),
          qq: publicQQConfig(qqConfig(cfg.qq)),
          clipboard: { ...CLIP_DEFAULTS, ...(cfg.clipboard || {}) }
        }
      });
    }

    if (req.method === "POST" && path === "/api/cloud/sync") {
      const r = await syncCloud("手动");
      return send(res, 200, r);
    }

    if (req.method === "POST" && path === "/api/test-notify") {
      const r = await notify({ title: "测试提醒", body: "看到这条说明通道是通的。", kind: "test" });
      return send(res, 200, { ok: true, detail: r });
    }

    // 待确认的收件箱条目：加入 / 忽略
    const inboxAct = /^\/api\/inbox\/([\w-]+)\/(add|dismiss)$/.exec(path);
    if (req.method === "POST" && inboxAct) {
      const idx = store.inbox.findIndex(i => i.id === inboxAct[1]);
      if (idx < 0) return send(res, 404, { error: "这条已经不在收件箱里了" });
      const entry = store.inbox[idx];
      store.inbox.splice(idx, 1);
      if (inboxAct[2] === "dismiss") {
        await store.flush();
        return send(res, 200, { ok: true });
      }
      const { parsed, engine } = await analyze(entry.text || "");
      const r = await commitTask({ text: entry.text || "", parsed, engine, source: entry.source || "收件箱" });
      return send(res, 200, { ok: true, ...r });
    }

    send(res, 404, { error: "没有这个接口" });
  } catch (err) {
    log("错误：", err.message);
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
}

// 公网监听的守卫。顺序很重要：先看令牌，再看路不路由 ——
// 反过来的话，攻击者能靠 404 和 401 的差异摸出哪些接口存在。
function guardMobile(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const given = String(url.searchParams.get("t") || req.headers["x-todo-token"] || "");
  const want = String(config.mobile?.token || "");
  if (!want) { send(res, 403, { error: "手机端没启用" }); return false; }

  // 页面本身不含密钥（密钥存在浏览器 localStorage 里），所以允许直接打开 /m。
  // 这样"加到主屏幕"后点图标就行，不用每次都带一长串 t=。
  // 真正需要防的是下面的 API，校验照旧。
  if (req.method === "GET" && (url.pathname === "/m" || url.pathname === "/m/")) return true;
  // 安装包同理：它不含数据，只是拿来装的
  if (req.method === "GET" && url.pathname === "/todo.apk") return true;

  // 定长比较，别让响应时间泄露前缀匹配了多少位
  const a = Buffer.from(given), b = Buffer.from(want);
  const same = a.length === b.length && a.length > 0
    && (() => { let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; })();

  if (!same) {
    if (hits.size > 400) hits.clear();
    const ip = req.socket.remoteAddress || "?";
    hits.set(ip, (hits.get(ip) || 0) + 1);
    if (hits.get(ip) > 20) { res.writeHead(429); res.end("too many"); return false; }
    send(res, 401, { error: "链接无效" });
    return false;
  }
  return true;
}
const hits = new Map();

// 手机端还要限制路由白名单：即使密钥有效，也不该能改配置、读日志、动规则文件。
function allowMobile(path) {
  return MOBILE_ALLOW.has(path)
    || path === "/api/mobile/done"
    || path === "/api/mobile/drop";
}

// 打开浏览器只在有桌面的 Windows 上有意义。云服务器上没有图形界面，
// spawn 一个不存在的 xdg-open 会抛 ENOENT 把进程带走，所以这里按平台分流。
function openBrowser(url) {
  if (process.platform !== "win32") {
    log(`（无桌面环境，不自动开浏览器）${url}`);
    return;
  }
  try {
    spawn("cmd", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    log("打开浏览器失败：", err.message);
  }
}

// 重复启动（比如开机自启 + 手动点了一次）不该报错，直接把页面调出来
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    const url = `http://127.0.0.1:${PORT}`;
    log(`端口 ${PORT} 上已经有一个在跑了，直接打开 ${url}`);
    watcher.stop();
    if (!process.env.TODO_NO_OPEN) openBrowser(url);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  log("服务起不来：", err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  log(`待办提醒已启动：${url}`);
  log(`规则目录：${join(ROOT, "rules")}　数据：${join(DATA, "db.json")}`);
  if (ruleBook.error) log("规则有问题：", ruleBook.error);

  // Linux 上 NapCat 的 HTTP 上报不一定可靠（社区实录里出现过「显示已启动但收不到事件」），
  // 配上 ws 就额外订一份：两条通道同时开也不会重复处理，私聊按 message_id 去重。
  // 配置：data/config.json 的 qq.ws，或环境变量 TODO_QQ_WS=ws://127.0.0.1:3001
  const wsUrl = String(process.env.TODO_QQ_WS || config?.qq?.ws || "").trim();
  if (wsUrl) {
    startOneBotWs({
      url: wsUrl,
      token: String(config?.qq?.token || ""),
      log,
      onEvent: ev => handleOneBot(ev, {}, new URLSearchParams())
    });
    log(`QQ 事件订阅（WS）：${wsUrl}`);
  }
  if (!process.env.TODO_NO_OPEN) openBrowser(url);

  // 公网监听：手机端入口。默认关，配了 mobile.enabled 才开。
  // 开了就必须有 token（上面已保证非空），否则等于把待办挂在公网上。
  if (config.mobile?.enabled === true) {
    const mport = Number(process.env.TODO_MOBILE_PORT || config.mobile.port || 6099);
    const mobileServer = http.createServer((req, res) => {
      const p = new URL(req.url, "http://127.0.0.1").pathname;
      try {
        if (!guardMobile(req, res)) return;
        if (!allowMobile(p)) return send(res, 404, { error: "没有这个接口" });
        handleRequest(req, res);
      } catch (err) {
        // 单个请求出岔子只能坏这一个请求，不能让整个服务倒下去 ——
        // 手机那边看到的就是"网页无法打开"，而我这边只收到一条重启记录。
        log("手机端请求出错：", p, err.message);
        send(res, 500, { error: err.message });
      }
    });
    mobileServer.on("error", err => log(`手机端监听 ${mport} 失败：`, err.message));
    mobileServer.listen(mport, "0.0.0.0", () => {
      log(`手机端已开：${mport} 端口　/m?t=${config.mobile.token}`);
    });
  }

  // NapCat 常常比我们起得晚（开机后要等登录），隔一会儿多试几次，把停机期间漏的消息补回来。
  // 20 分钟都没成功说明 NapCat 没起来，等它起来后由下面的看门狗接手。
  let bootCaughtUp = false;
  (async () => {
    for (let i = 0; i < 40 && !bootCaughtUp; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 6000 : 30000));
      const r = await catchUpQQ();
      if (r.ok) {
        bootCaughtUp = true;
        log(r.count ? `补处理完成：${r.count} 条（扫了 ${r.scanned} 条历史）` : "补处理：没有漏掉的消息");
        return;
      }
      if (r.skipped) { log(`补处理跳过：${r.error}`); return; }
      log(`补处理没成功（第 ${i + 1} 次）：${r.error}`);
    }
    if (!bootCaughtUp) log("补处理：20 分钟内 NapCat 一直没连上，它上线后会自动再补一次");
  })();

  // 看门狗：服务一直开着但 NapCat 掉线过（断网、退出登录、被 OOM 杀掉、重启），
  // 这期间的消息不会有上报，等它重新上线时补一次。
  // 同时盯着掉线时长：超过阈值就发邮件喊人，否则可能出现「凌晨掉了、中午才发现」。
  let qqOnline = true;
  let offlineSince = 0;
  let offlineAlerted = false;
  setInterval(async () => {
    const cfg = qqConfig(config.qq);
    if (!cfg.enabled) return;
    const p = await qqProbe(cfg);
    const nowOnline = Boolean(p.ok);
    if (nowOnline && !qqOnline) {
      log("NapCat 重新上线了，补一次掉线期间的消息");
      const r = await catchUpQQ();
      if (!r.ok) log(`掉线补处理失败：${r.error || r.skipped}`);
      else if (r.count) log(`掉线补处理完成：${r.count} 条`);
      if (offlineAlerted && config.alert?.notifyOnRecover !== false) {
        const mins = Math.max(1, Math.round((Date.now() - offlineSince) / 60_000));
        await sendAlert(
          "【待办提醒】小号已恢复在线",
          `刚才断了约 ${mins} 分钟，现在已经重新登录。\n` +
            (r.count ? `掉线期间漏掉的 ${r.count} 条消息已补处理。` : "掉线期间没有漏掉的消息。")
        );
      }
      offlineSince = 0;
      offlineAlerted = false;
    } else if (!nowOnline && qqOnline) {
      log("NapCat 掉线了，等它回来之后补消息");
      offlineSince = Date.now();
      offlineAlerted = false;
    } else if (!nowOnline && offlineSince && !offlineAlerted) {
      // 注意别写成 `config.alert?.offlineMinutes || 10`：0 也是合法值（立即告警），
      // 用 || 会被当成没填而回落到 10 分钟。
      const raw = config.alert?.offlineMinutes;
      const threshold = Number.isFinite(Number(raw)) ? Number(raw) : 10;
      const mins = Math.round((Date.now() - offlineSince) / 60_000);
      if (mins >= threshold) {
        offlineAlerted = true;
        await sendAlert(
          `【待办提醒】小号掉线了（已 ${mins} 分钟）`,
          [
            `小号 ${config.qq?.bot || "（未配置）"} 从 ${new Date(offlineSince).toLocaleString("zh-CN", { hour12: false })} 起失联，到现在 ${mins} 分钟。`,
            "",
            "可能的原因：服务器内存不足把 QQ 进程杀了、小号被踢下线、或者容器挂了。",
            "这段时间发进来的消息收不到，等你扫码恢复后会自动补处理。",
            "",
            "恢复方法：SSH 上服务器看日志，按需要重新扫码登录。"
          ].join("\n")
        );
      }
    }
    qqOnline = nowOnline;
  }, 90_000);
});

process.on("SIGINT", async () => { await store.flush(); process.exit(0); });
