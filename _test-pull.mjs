// 验证手机页的「下拉刷新」真能重载页面。
//
// 为什么单独测：WebView 里没有浏览器那套原生下拉刷新，这套手势是自己认的，
// 光看代码看不出对不对 —— 得真派发触摸事件，再看页面有没有重新加载。
// 判定「重新加载」用 sessionStorage 计数（每次文档创建 +1），比看 URL 可靠：
// 页面启动后会把 t= 之类从地址栏抹掉，URL 上什么都留不下。
//
// 用法：先在 _tm-test 起服务（3979），再 node _test-pull.mjs
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP = 9338;
const cfg = JSON.parse(readFileSync("./_tm-test/config.json", "utf8"));
const URL = process.env.APP_URL
  || `http://127.0.0.1:${cfg.mobile.port}/m?t=${encodeURIComponent(cfg.mobile.token)}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

const dir = await mkdtemp(join(tmpdir(), "pull-"));
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
  // 每次文档创建都记一笔，用来判断"页面确实重新加载了"
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try{var b=(+sessionStorage.getItem('boots')||0)+1;"
      + "sessionStorage.setItem('boots',String(b));}catch(e){}"
  });

  const boots = () => evalJs("+sessionStorage.getItem('boots')||0");

  // 派发一段真实的触摸：touchstart → touchmove → touchend
  const touch = async (type, y, moving) => {
    const list = moving ? "true" : "false";
    return evalJs(`(function(){
      var t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: ${y} });
      document.body.dispatchEvent(new TouchEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true,
        touches: ${list} ? [t] : [], targetTouches: ${list} ? [t] : [], changedTouches: [t]
      }));
      return "ok";
    })()`);
  };

  await send("Page.navigate", { url: URL });
  await sleep(2500);

  console.log("\n[1] 页面正常起来");
  ok(await evalJs("!document.getElementById('app').hidden"), "任务区已显示");
  ok(await evalJs("!!document.getElementById('btnReload')"), "页头有刷新按钮");
  ok(await boots() === 1, "第一次加载，boots = 1", await boots());

  console.log("\n[2] 拉得太短：只提示，不刷新");
  await touch("touchstart", 300, true);
  await touch("touchmove", 340, true);
  const shortTip = await evalJs(`document.getElementById("pullTip").className + "|"
    + document.getElementById("pullTip").textContent`);
  ok(String(shortTip).includes("on"), "顶部出现提示", shortTip);
  ok(String(shortTip).includes("下拉刷新"), "文案是「下拉刷新」", shortTip);
  ok(!String(shortTip).includes("ready"), "还没到触发线", shortTip);
  await touch("touchend", 340, false);
  await sleep(900);
  ok(await boots() === 1, "页面没被重载", await boots());
  ok(!String(await evalJs(`document.getElementById("pullTip").className`)).includes("on"), "提示收起来了");

  console.log("\n[3] 拉够了：松开就重载");
  await touch("touchstart", 280, true);
  await touch("touchmove", 300, true);
  await touch("touchmove", 420, true);
  const longTip = await evalJs(`document.getElementById("pullTip").className + "|"
    + document.getElementById("pullTip").textContent`);
  ok(String(longTip).includes("ready"), "过了触发线", longTip);
  ok(String(longTip).includes("松开刷新"), "文案变成「松开刷新」", longTip);
  await touch("touchend", 420, false);
  await sleep(2200);
  const b3 = await boots();
  ok(b3 === 2, "页面确实重新加载了（boots = 2）", b3);
  ok(await evalJs("!document.getElementById('app').hidden"), "重载后数据还在");

  console.log("\n[4] 点页头的刷新按钮");
  await evalJs(`document.getElementById("btnReload").click()`);
  await sleep(2200);
  const b4 = await boots();
  ok(b4 === 3, "也重载了一次（boots = 3）", b4);

  console.log("\n[5] 手指按下再往上推，不该触发");
  await touch("touchstart", 400, true);
  await touch("touchmove", 300, true);
  await touch("touchend", 300, false);
  await sleep(900);
  ok(await boots() === 3, "往上滑不刷新", await boots());

  console.log("\n[6] 页面滚到中间再下拉，不该触发");
  // 内容不足一屏时根本滚不动，先垫高再测，否则这条用例等于没测
  await evalJs(`document.body.insertAdjacentHTML("beforeend",
    '<div style="height:1600px"></div>');window.scrollTo(0, 300);`);
  await sleep(300);
  const sy = await evalJs("window.scrollY");
  ok(sy > 0, "确实滚下去了", sy);
  await touch("touchstart", 300, true);
  await touch("touchmove", 500, true);
  await touch("touchend", 500, false);
  await sleep(900);
  ok(await boots() === 3, "不在顶部时下拉不刷新", await boots());

  // 收尾：给一张截图，人眼过一下页头那颗刷新
  await evalJs("window.scrollTo(0, 0)");
  await sleep(300);
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile("_shotpull.png", Buffer.from(r.result.data, "base64"));
  console.log("saved _shotpull.png");

  ws.close();
} finally {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(300);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log("\n结果：" + pass + " 通过，" + fail + " 失败\n");
process.exit(fail ? 1 : 0);
