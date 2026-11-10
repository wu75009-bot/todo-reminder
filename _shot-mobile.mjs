// 手机页面截图。接口测过不代表页面能看 —— 布局、换行、深浅色都得亲眼过一遍。
// 用法：先起服务（TODO_MOBILE_PORT=16099），再 node _shot-mobile.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP = 9334;
// 默认连本地测试环境；也可以给 APP_URL / APP_TOKEN 指向线上的
const URL = process.env.APP_URL
  ? process.env.APP_URL
  : (() => {
      const cfg = JSON.parse(readFileSync("./_tm-test/config.json", "utf8"));
      return `http://127.0.0.1:${cfg.mobile.port}/m?t=${encodeURIComponent(cfg.mobile.token)}`;
    })();
const SEED = process.env.APP_URL ? "" : "1";   // 线上不写测试数据
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

const dir = await mkdtemp(join(tmpdir(), "shotm-"));
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

  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`_shotm-${name}.png`, Buffer.from(r.result.data, "base64"));
    console.log("saved", `_shotm-${name}.png`);
  };

  // 本地才造数据：线上截图是给用户看真实状态的，不能往里塞测试任务
  if (SEED) {
    const tok = new URL(URL).searchParams.get("t");
    const base = new URL(URL).origin;
    const seed = [
      "11月20日下午3点 交物理实验报告，要带上周的数据",
      "12月5日 高等数学期中考试 上午9点 教三201",
      "明天晚上8点 记得给导师发进度汇报"
    ];
    for (const text of seed) {
      await fetch(`${base}/api/add`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-todo-token": tok },
        body: JSON.stringify({ text, source: "手机" })
      });
    }
  }

  // 明确指定浅色，否则 headless 默认跟着系统走，两种模式都看不到干净的对比
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.navigate", { url: URL });
  await sleep(2200);
  await shot("light");

  const state = await evalJs(`document.getElementById("tasks").innerText`);
  console.log("列表文本:\n" + String(state).slice(0, 400));

  // 输一条，看识别结果卡片长什么样。线上跳这一步，免得污染真实数据。
  if (SEED) {
    await evalJs(`(() => {
      const t = document.getElementById("input");
      t.value = "周五上午10点 到教务处交奖学金申请表，带上成绩单";
      t.dispatchEvent(new Event("input"));
      document.getElementById("send").click();
    })()`);
    await sleep(2600);
    await shot("result");

    const card = await evalJs(`document.getElementById("result").innerText`);
    console.log("结果卡片:\n" + String(card).slice(0, 400));
  }

  // 深色
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  await shot("dark");

  // 窄屏兜底：320 宽会不会挤坏
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await shot("narrow");

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
