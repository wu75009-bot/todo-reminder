// 验证「同步到手机日历」会先弹确认，确认之后才真往系统日历里写。
//
// 关键点：往系统日历写事件是有副作用的，点一下闷头写进去就不礼貌了。
// 所以这里断言「刚点链接时原生同步一次都没被调」，点了确认才调。
//
// 用法：先在 _tm-test 起服务（3979），再 node _test-cal.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP = 9339;
const cfg = JSON.parse(readFileSync("./_tm-test/config.json", "utf8"));
const BASE = `http://127.0.0.1:${cfg.mobile.port}`;
const URL = `http://127.0.0.1:${cfg.mobile.port}/m?t=${encodeURIComponent(cfg.mobile.token)}`;
const H = { "X-Todo-Token": cfg.mobile.token, "Content-Type": "application/json" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

// 先给一条任务挂个未来的提醒点，否则 60 天内没有日程，面板根本不会出现
const st = await (await fetch(BASE + "/api/state", { headers: H })).json();
const task = (st.tasks || []).find(t => !t.done);
if (!task) throw new Error("隔离库里没有进行中的任务，先造一条再跑");
const at = new Date(Date.now() + 26 * 3600_000);
await fetch(BASE + "/api/mobile/reminders", {
  method: "POST", headers: H,
  body: JSON.stringify({ id: task.id, points: [at.toISOString()] })
});
const cal = await (await fetch(BASE + "/api/calendar.json?days=60", { headers: H })).json();
console.log("日历里现有 " + (cal.events || []).length + " 条日程\n");

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

const dir = await mkdtemp(join(tmpdir(), "cal-"));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + dir,
  "about:blank"
], { stdio: "ignore" });

try {
  if (!await waitFor(`http://127.0.0.1:${CDP}/json/version`)) throw new Error("Edge 没起来");
  const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expression => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

  await send("Page.navigate", { url: URL });
  await sleep(2500);

  // 冒充 App 的原生桥，记录被调了几次。这样既测到「确认后才同步」，
  // 又不会真往系统日历写东西。
  await evalJs(`window.__synced = 0;
    window.TodoApp = { syncCalendar: function () { window.__synced++; } };`);

  console.log("[1] 点「同步到手机日历」先出确认，不动日历");
  await evalJs(`document.getElementById("icsLink").click()`);
  await sleep(900);
  ok(await evalJs("!document.getElementById('calSheet').hidden"), "确认面板弹出来了");
  ok(await evalJs("window.__synced") === 0, "还没往日历里写任何东西", await evalJs("window.__synced"));

  const title = await evalJs(`document.getElementById("calTitle").textContent`);
  ok(title === "同步到手机日历", "标题正确", title);

  const who = await evalJs(`document.getElementById("calWho").textContent`);
  const n = (cal.events || []).length;
  ok(String(who).includes("共 " + n + " 条"), "说明了要写几条", who);

  const rows = await evalJs(`document.querySelectorAll("#calList .calrow").length`);
  ok(rows === Math.min(30, n), "列表行数和日程数对得上", rows);
  ok(String(await evalJs(`document.getElementById("calGo").textContent`)) === "写进日历", "按钮是「写进日历」");

  await writeFile("_shotcal.png", Buffer.from(
    (await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  console.log("saved _shotcal.png");

  console.log("\n[2] 点取消：面板收起，日历还是没动");
  await evalJs(`document.getElementById("calCancel").click()`);
  await sleep(400);
  ok(await evalJs("document.getElementById('calSheet').hidden"), "面板关掉了");
  ok(await evalJs("window.__synced") === 0, "日历依然没被写", await evalJs("window.__synced"));

  console.log("\n[3] 再点开、这次确认：这时才写");
  await evalJs(`document.getElementById("icsLink").click()`);
  await sleep(900);
  await evalJs(`document.getElementById("calGo").click()`);
  await sleep(600);
  ok(await evalJs("window.__synced") === 1, "原生同步被调了一次", await evalJs("window.__synced"));
  ok(await evalJs("document.getElementById('calSheet').hidden"), "点完顺手关掉面板");

  console.log("\n[4] 点遮罩也能关");
  await evalJs(`document.getElementById("icsLink").click()`);
  await sleep(900);
  await evalJs(`document.querySelector("#calSheet .sheet-mask").click()`);
  await sleep(300);
  ok(await evalJs("document.getElementById('calSheet').hidden"), "遮罩点一下关掉");

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(300);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log("\n结果：" + pass + " 通过，" + fail + " 失败\n");
process.exit(fail ? 1 : 0);
