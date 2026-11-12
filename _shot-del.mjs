// 截「删掉」的确认过程：点一下变成确认行、确认后带撤销的提示。
// 删除是不可逆操作，光看代码不敢保证那颗「真的删」按钮没被挤到屏幕外。
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP = 9338;
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

const dir = await mkdtemp(join(tmpdir(), "shotdel-"));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + dir, "about:blank"
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
    if (r.result?.exceptionDetails) console.log("JS 异常:", r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`_shotdel-${name}.png`, Buffer.from(r.result.data, "base64"));
    console.log("saved", `_shotdel-${name}.png`);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.navigate", { url: URL });
  await sleep(2400);

  console.log("卡片数:", await evalJs(`document.querySelectorAll("#tasks .task").length`));

  console.log("\n[1] 点一下「删掉」，不该真删，只该换成确认行");
  const before = await evalJs(`document.querySelectorAll("#tasks .task").length`);
  console.log("确认行:", await evalJs(`(() => {
    const b = document.querySelector('#tasks .task button[data-act="drop"]');
    if (!b) return "没找到删掉按钮";
    b.click();
    const row = document.querySelector("#tasks .task .actions.confirm");
    return row ? row.innerText.replace(/\\n/g, " | ") : "没出现确认行";
  })()`));
  await sleep(300);
  await shot("confirm");
  console.log("卡片数（应不变）:", await evalJs(`document.querySelectorAll("#tasks .task").length`));

  console.log("\n[2] 点「取消」，回到原来的三个按钮");
  console.log("取消后:", await evalJs(`(() => {
    const b = document.querySelector('#tasks .task button[data-act="cancel-drop"]');
    if (!b) return "没找到取消";
    b.click();
    return [...document.querySelectorAll("#tasks .task .actions button")].map(x => x.textContent).join(" / ");
  })()`));
  await sleep(300);

  console.log("\n[3] 再来一次，这回真删");
  const n0 = await evalJs(`document.querySelectorAll("#tasks .task").length`);
  await evalJs(`document.querySelector('#tasks .task button[data-act="drop"]').click()`);
  await sleep(250);
  await evalJs(`document.querySelector('#tasks .task button[data-act="drop-now"]').click()`);
  await sleep(1200);
  const n1 = await evalJs(`document.querySelectorAll("#tasks .task").length`);
  console.log("卡片数 " + n0 + " → " + n1);
  console.log("提示:", await evalJs(`document.getElementById("toast").innerText.replace(/\\n/g," ")`));
  console.log("提示可点:", await evalJs(`document.getElementById("toast").classList.contains("has-act")`));
  await shot("undo");

  console.log("\n[4] 点「撤销」");
  await evalJs(`document.getElementById("toastAct") && document.getElementById("toastAct").click()`);
  await sleep(1400);
  console.log("撤销后卡片数:", await evalJs(`document.querySelectorAll("#tasks .task").length`));
  console.log("提示:", await evalJs(`document.getElementById("toast").innerText.replace(/\\n/g," ")`));
  await shot("restored");

  // 深色 / 窄屏的确认行
  await evalJs(`document.querySelector('#tasks .task button[data-act="drop"]').click()`);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(400);
  await shot("dark");
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  await shot("narrow");

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
