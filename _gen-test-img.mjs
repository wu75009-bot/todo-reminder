// 生成一张「群通知截图」测试图：用 Edge headless 渲染一段中文，再截图存成 PNG。
// 用来验证群聊里发图片，它到底看没看见、看不看得懂。
// 跑法：node _gen-test-img.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9335;
const OUT = "_test-group-img.png";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; width:900px; height:320px; background:#fff;
         font-family:"Microsoft YaHei",sans-serif; color:#111; }
  .box { padding:28px 34px; }
  h1 { font-size:34px; margin:0 0 18px; }
  p { font-size:24px; margin:6px 0; }
</style>
<div class="box">
  <h1>高数作业周五晚上10点前交</h1>
  <p>交到教三 502 门口的作业箱</p>
  <p>过期不收，别拖到最后一刻</p>
</div>`;

const dir = await mkdtemp(join(tmpdir(), "genimg-"));
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + dir,
  "--window-size=900,320",
  "about:blank"
], { stdio: "ignore" });

try {
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 20000) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch {}
    await sleep(200);
  }
  if (!up) throw new Error("Edge 没起来");

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

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 320, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
  await sleep(1200);

  const r = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(OUT, Buffer.from(r.result.data, "base64"));
  console.log("wrote", OUT);
  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(300);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
