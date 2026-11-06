// 用 Edge headless + CDP 截图，确认界面改动没把布局弄坏。
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
const APP = process.env.APP_URL || "http://127.0.0.1:3790/";
const PREFIX = process.env.SHOT_PREFIX || "_shot";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

const dir = await mkdtemp(join(tmpdir(), "shot-"));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + dir,
  "--window-size=1440,1000",
  "about:blank"
], { stdio: "ignore" });

try {
  if (!await waitFor(`http://127.0.0.1:${PORT}/json/version`)) throw new Error("Edge 没起来");
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expression => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: APP });
  await sleep(1800);

  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(`${PREFIX}-${name}.png`, Buffer.from(r.result.data, "base64"));
    console.log("saved", `${PREFIX}-${name}.png`);
  };

  await shot("main");

  await evalJs(`document.getElementById("btn-llm").click()`);
  await sleep(500);
  await shot("llm-dialog");

  await evalJs(`document.getElementById("llm-cancel").click()`);
  await sleep(300);

  await evalJs(`document.getElementById("btn-qq").click()`);
  await sleep(500);
  await shot("qq-dialog");
  await evalJs(`document.getElementById("qq-cancel").click()`);
  await sleep(300);

  await evalJs(`(() => { const t = document.getElementById("text");
    t.value = "【高等数学】实验报告于11月10日23:59前提交到教学平台，逾期不候。";
    t.dispatchEvent(new Event("input")); })()`);
  await sleep(1500);
  await shot("preview-rule");

  // 点「让模型再看看」，走模型路径
  const clicked = await evalJs(`(() => { const b = document.getElementById("btn-force-model"); if (!b) return "no-button"; b.click(); return "ok"; })()`);
  console.log("点让模型再看看:", clicked);
  await sleep(2500);
  await shot("preview-model");

  const summary = await evalJs(`document.getElementById("preview").innerText`);
  console.log("预览文本:\n" + String(summary).slice(0, 600));

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
