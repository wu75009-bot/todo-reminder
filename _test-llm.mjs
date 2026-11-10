// 模型兜底的端到端测试。不需要真 API Key：起一个本地假接口，把 baseUrl 指过去。
// 重点验证「模型编日期」能不能被拦住 —— 这比它认对更值得测。
import { spawn, execSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname);
const PORT = 3791;
const MOCK_PORT = 3801;
const BASE = `http://127.0.0.1:${PORT}`;
// 一张带文字的图，用来测图片识别。没有就跳过图片相关用例。
const IMG = process.env.TEST_IMG || "";

// 测试用独立数据目录，完全不碰你真实的 data/（任务、API Key 都在那儿）
const DATA = join(ROOT, "_test-data");
const CFG = join(DATA, "config.json");
const TMP = join(DATA, "tmp");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}${extra !== undefined ? "  → " + JSON.stringify(extra) : ""}`); }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Windows 上 child.kill() 经常杀不掉 node 子进程，会用旧进程接着跑，
// 导致测试实际上连着上一轮的服务、清理也失效。必须用 taskkill 连子树一起收。
function killTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); return true; } catch { return false; }
}

function freePort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = new Set();
    for (const line of out.split("\n")) {
      if (!/LISTENING/.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
    for (const pid of pids) killTree(pid);
    return pids.size;
  } catch { return 0; }
}

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

// 先把可能残留的上一轮进程收掉，否则会连到旧服务上，测试全绿但测的是别人
const killed = freePort(PORT) + freePort(MOCK_PORT);
if (killed) console.log(`清掉了 ${killed} 个占用端口的残留进程`);
await sleep(400);

await rm(DATA, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
await writeFile(CFG, JSON.stringify({
  llm: {
    enabled: true,
    apiKey: "sk-mock-key",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    model: "deepseek-flash",
    mode: "fallback",
    imageMode: "model"
  }
}, null, 2), "utf8");

const mock = spawn(process.execPath, ["_mock-llm.mjs"], {
  cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "pipe"
});
mock.stdout.on("data", d => process.stdout.write("[mock] " + d));
mock.stderr.on("data", d => process.stdout.write("[mock!] " + d));

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, TODO_PORT: String(PORT), TODO_NO_OPEN: "1", TODO_DATA: DATA, TODO_TMP: TMP },
  stdio: "pipe"
});
server.stdout.on("data", d => process.stdout.write("[svr] " + d));
server.stderr.on("data", d => process.stdout.write("[svr!] " + d));

function cleanup() {
  killTree(server.pid);
  killTree(mock.pid);
  freePort(PORT);
  freePort(MOCK_PORT);
}

try {
  const up = await waitFor(`${BASE}/api/state`);
  if (!up) throw new Error("服务没起来");
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/__log`);

  console.log("\n--- 1. 强制走模型，正常识别 ---");
  const r1 = await post("/api/parse", {
    text: "【高等数学】实验报告于11月10日23:59前提交到教学平台",
    force: "always"
  });
  ok(r1.engine === "model", "走了模型", r1.engine);
  ok(String(r1.parsed?.due || "").startsWith("2026-11-10"), "截止时间认对了", r1.parsed?.due);
  ok(r1.model?.ok === true, "模型调用成功");
  ok(r1.model?.usage?.inputTokens === 900, "记下了输入 token", r1.model?.usage);
  ok(r1.model?.usage?.costCNY > 0, "算出了花费", r1.model?.usage?.costCNY);
  ok(r1.planned?.length > 0, "排出了提醒", r1.planned?.length);

  console.log("\n--- 2. 模型编了一个原文没有的日期 ---");
  const r2 = await post("/api/parse", { text: "HALLUCINATE 记得交实验报告", force: "always" });
  ok(r2.parsed?.due === null, "编造的日期被作废", r2.parsed?.due);
  ok(r2.parsed?.needsInfo === true, "被标成缺时间");
  ok(r2.parsed?.notes?.some(n => n.includes("找不到")), "给出了作废原因", r2.parsed?.notes);
  ok(r2.parsed?.confidence <= 0.5, "把握被下调", r2.parsed?.confidence);

  console.log("\n--- 3. 有日期但没给出原文依据 ---");
  const r3 = await post("/api/parse", { text: "NO_EVIDENCE 读书报告", force: "always" });
  ok(r3.parsed?.due === null, "无依据的日期被作废", r3.parsed?.due);
  ok(r3.parsed?.notes?.some(n => n.includes("依据")), "说明了缺依据", r3.parsed?.notes);

  console.log("\n--- 4. 模型把开始和结束写反了 ---");
  const r4 = await post("/api/parse", { text: "SWAPPED 周五下午三点到五点开会", force: "always" });
  ok(Date.parse(r4.parsed?.start) < Date.parse(r4.parsed?.end), "自动对调成开始早于结束",
    [r4.parsed?.start, r4.parsed?.end]);
  ok(r4.parsed?.notes?.some(n => n.includes("对调")), "说明了已对调");

  console.log("\n--- 5. 图片直接给模型看 ---");
  // 提到外层：第 10 组还要用同一张图，声明在 else 块里会「b64 is not defined」
  let b64 = "";
  if (!IMG || !existsSync(IMG)) {
    console.log("  跳过：没设 TEST_IMG 环境变量，或文件不存在");
  } else {
  b64 = (await readFile(IMG)).toString("base64");
  const r5 = await post("/api/ocr", { dataUrl: `data:image/png;base64,${b64}` });
  ok(r5.ok === true, "图片处理成功", r5.error);
  ok(r5.engine === "model", "走的是模型直读，不是 OCR", r5.engine);
  ok(r5.parsed?.typeName === "考试", "认出了考试", r5.parsed?.typeName);
  ok(String(r5.parsed?.start || "").includes("T19:00"), "开始时间对", r5.parsed?.start);
  ok(String(r5.parsed?.end || "").includes("T21:00"), "结束时间对", r5.parsed?.end);
  ok((r5.text || "").includes("高等数学"), "回传了模型读到的原文", (r5.text || "").slice(0, 40));
  ok(r5.planned?.length > 0, "排出了提醒", r5.planned?.length);
  }

  console.log("\n--- 6. 连通性测试 ---");
  const r6 = await post("/api/llm-probe", { llm: {} });
  ok(r6.ok === true, "测试通过", r6.error);
  ok(r6.latencyMs >= 0, "报了延迟", r6.latencyMs);

  console.log("\n--- 7. 规则有把握时不花钱 ---");
  const r7 = await post("/api/parse", {
    text: "【高等数学】实验报告于11月10日23:59前提交到教学平台，逾期不候。",
    force: "auto"
  });
  ok(r7.engine === "rule", "没调模型", r7.engine);
  ok(r7.model?.skipped === true, "明确标记为跳过", r7.model);

  console.log("\n--- 8. 模型挂了也不能牵连规则 ---");
  await post("/api/config", { llm: { apiKey: "sk-wrong", enabled: true } });
  const r8 = await post("/api/parse", { text: "老师说下周三要检查宿舍卫生", force: "always" });
  ok(r8.engine === "rule", "退回了规则结果", r8.engine);
  ok(r8.model?.ok === false, "标出了模型失败");
  ok(String(r8.model?.error || "").includes("API Key"), "说清了是 Key 的问题", r8.model?.error);
  ok(r8.parsed?.typeName, "规则结果仍然可用", r8.parsed?.typeName);

  console.log("\n--- 9. 缓存不重复计费 ---");
  await post("/api/config", { llm: { apiKey: "sk-mock-key", enabled: true } });
  const c1 = await post("/api/parse", { text: "缓存测试：11月12日交物理作业", force: "always" });
  const c2 = await post("/api/parse", { text: "缓存测试：11月12日交物理作业", force: "always" });
  ok(c1.engine === "model" && c2.engine === "model", "两次都是模型结果");
  ok(c2.model?.cached === true, "第二次命中缓存", c2.model?.cached);

  console.log("\n--- 10. 模型连不上时，图片退回本地 OCR ---");
  if (!b64) {
    console.log("  跳过：第 5 步没有图可用");
  } else {
    await post("/api/config", { llm: { baseUrl: "http://127.0.0.1:9", apiKey: "sk-mock-key", enabled: true } });
    const r10 = await post("/api/ocr", { dataUrl: `data:image/png;base64,${b64}` });
    ok(r10.ok === true, "OCR 兜住了，没让整条路断掉", r10.error);
    ok(r10.engine === "ocr", "标记成走的本地 OCR", r10.engine);
    ok((r10.text || "").length > 5, "取到了文字", (r10.text || "").length);
    ok(r10.model?.ok === false, "同时如实报告了模型失败");
  }
} catch (err) {
  fail++;
  console.log("\n测试崩了：" + err.message);
} finally {
  cleanup();
  await sleep(800);
  await rm(DATA, { recursive: true, force: true });
  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  console.log(`测试数据：${existsSync(DATA) ? "没删掉（" + DATA + "），手动删一下" : "已清理，没碰你的 data/"}`);
  process.exit(fail ? 1 : 0);
}
