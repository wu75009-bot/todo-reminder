// 截「改提醒时间」面板：浅色、深色、窄屏。
// 面板这种东西光看代码看不出错位，必须真渲染一遍。
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP = 9336;
// 默认连本地测试环境；给 APP_URL 就截线上
const URL = process.env.APP_URL || (() => {
  const cfg = JSON.parse(readFileSync("./_tm-test/config.json", "utf8"));
  return `http://127.0.0.1:${cfg.mobile.port}/m?t=${encodeURIComponent(cfg.mobile.token)}`;
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

const dir = await mkdtemp(join(tmpdir(), "shotsheet-"));
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
    if (r.result?.exceptionDetails) console.log("JS 异常:", JSON.stringify(r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`_shotsheet-${name}.png`, Buffer.from(r.result.data, "base64"));
    console.log("saved", `_shotsheet-${name}.png`);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.navigate", { url: URL });
  await sleep(2400);

  const n = await evalJs(`document.querySelectorAll("#tasks .task").length`);
  console.log("卡片数:", n);
  console.log("卡片文本:", String(await evalJs(`document.getElementById("tasks").innerText`)).slice(0, 300));

  // 打开第一条的「改时间」
  const opened = await evalJs(`(() => {
    const b = document.querySelector('#tasks .task button[data-act="edit"]');
    if (!b) return "没找到按钮";
    b.click();
    return document.getElementById("sheet").hidden ? "面板没打开" : "ok";
  })()`);
  console.log("打开面板:", opened);
  await sleep(500);
  await shot("light");

  console.log("面板文本:\n" + String(await evalJs(`document.querySelector(".sheet-body").innerText`)).slice(0, 500));

  // 点一个快捷时间，再删掉第一行，看列表变化
  const act = await evalJs(`(() => {
    const q = document.querySelector("#pquick button");
    if (q) q.click();
    const x = document.querySelector("#plist .prow .x");
    if (x) x.click();
    return document.querySelectorAll("#plist .prow").length;
  })()`);
  console.log("操作后行数:", act);
  await sleep(300);
  await shot("edited");

  // 深色
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  await shot("dark");

  // 窄屏 320：三个按钮 + 面板会不会挤坏
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await shot("narrow");

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
