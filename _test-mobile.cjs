// 手机端入口的回归测试（连一个已经起来的服务，自己不管进程）。
// 重点不是「能不能加任务」，而是「没钥匙的人什么都拿不到」：
// 这个端口是对公网开的，鉴权写错等于把待办清单公开。
//
// 用法：先起服务（TODO_DATA 指到隔离目录、TODO_MOBILE_PORT 指到测试端口），再 node _test-mobile.cjs
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = __dirname;
const DIR = path.join(ROOT, "_tm-test");
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const MPORT = Number(process.env.TODO_MOBILE_PORT || cfg.mobile.port);
const PORT = Number(process.env.TODO_PORT || 3790);
const TOKEN = cfg.mobile.token;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
};

function req(port, method, urlPath, { token, body, raw } = {}) {
  return new Promise((resolve) => {
    const data = raw != null ? String(raw) : (body ? JSON.stringify(body) : null);
    const headers = {};
    if (raw != null) headers["content-type"] = "text/plain; charset=utf-8";
    else if (data) headers["content-type"] = "application/json";
    if (token) headers["x-todo-token"] = token;
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, res => {
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => resolve({ code: res.statusCode, body: buf }));
    });
    r.on("error", e => resolve({ code: 0, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  let r = await req(MPORT, "GET", "/m");
  if (r.code === 0) {
    console.log("连不上 " + MPORT + "，先把服务起起来再跑这个脚本。");
    process.exit(2);
  }

  console.log("— 门锁 —");
  // 页面 HTML 里没有密钥（密钥在浏览器 localStorage），所以裸 /m 允许打开；
  // 真正要守住的是 API，下面几条才是关键。
  r = await req(MPORT, "GET", "/m");
  ok("裸 /m 只给空壳页面", r.code === 200 && r.body.includes("记下"), "got " + r.code);
  r = await req(MPORT, "GET", "/api/state");
  ok("无 token 读状态被拒", r.code === 401, "got " + r.code);
  r = await req(MPORT, "POST", "/api/add", { body: { text: "无 token 想写任务" } });
  ok("无 token 写任务被拒", r.code === 401, "got " + r.code);

  console.log("\n— 接口白名单 —");
  for (const p of ["/api/config", "/api/replan", "/api/cloud/sync", "/api/ocr", "/api/onebot", "/api/qq-catchup", "/api/rules/x.json"]) {
    const x = await req(MPORT, "POST", p, { token: TOKEN, body: {} });
    ok("不放行 " + p, x.code === 404, "got " + x.code);
  }

  console.log("\n— 正常使用 —");
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  ok("读状态", r.code === 200 && JSON.parse(r.body).tasks !== undefined);

  const text = "11月20日下午3点 交物理实验报告，要带上周的数据";
  r = await req(MPORT, "POST", "/api/add", { token: TOKEN, body: { text, source: "手机" } });
  const added = JSON.parse(r.body || "{}");
  ok("加任务成功", r.code === 200 && added.task && added.task.id, r.body.slice(0, 200));

  const id = added.task?.id;
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  const st = JSON.parse(r.body);
  const task = (st.tasks || []).find(t => t.id === id);
  ok("任务出现在列表里", Boolean(task));
  ok("排上了提醒点", Boolean(task && task.reminders && task.reminders.length),
    JSON.stringify(task && task.reminders));

  if (task && task.reminders && task.reminders.length) {
    // 「交报告」会被识别成截止类，时间在 due 而不是 start，两种都要认
    const anchor = task.start || task.due;
    ok("有起始或截止时间", Boolean(anchor), JSON.stringify({ start: task.start, due: task.due }));
    const a = new Date(anchor).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    ok("时间是 11/20 15:00", a.includes("11/20") && a.includes("15:00"), a);

    const fires = task.reminders.map(r => new Date(r.fireAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
    ok("提醒点都不晚于截止时间", fires.every(f => new Date(f).getTime() <= new Date(anchor).getTime() + 60000), fires.join(" | "));
    ok("至少有一个贴近截止的提醒", fires.some(f => f.includes("11/20")), fires.join(" | "));
  }

  console.log("\n— 完成与删除 —");
  r = await req(MPORT, "POST", "/api/mobile/done", { token: TOKEN, body: { id } });
  ok("标记完成", r.code === 200, "got " + r.code);
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  const t2 = (JSON.parse(r.body).tasks || []).find(t => t.id === id);
  ok("完成后 done=true", t2 && t2.done === true);
  ok("完成后提醒被压掉", t2 && (t2.reminders || []).every(x => x.status !== "pending"));

  r = await req(MPORT, "POST", "/api/mobile/drop", { token: TOKEN, body: { id } });
  ok("删除", r.code === 200, "got " + r.code);
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  ok("删干净了", !(JSON.parse(r.body).tasks || []).some(t => t.id === id));

  console.log("\n— 分享入口（转发即记）—");
  r = await req(MPORT, "POST", "/api/share", { raw: "今天下午四点 去教务处交实习鉴定表" });
  ok("无 token 分享被拒", r.code === 401, "got " + r.code);

  r = await req(MPORT, "POST", "/api/share", { token: TOKEN, raw: "今天下午四点 去教务处交实习鉴定表" });
  ok("分享能建任务", r.code === 200, "got " + r.code);
  ok("回的是纯文本、第一行『记下了』", r.body.startsWith("记下了："), JSON.stringify(r.body).slice(0, 120));
  ok("回复里带提醒时间或明确说没时间",
    r.body.includes("会提醒：") || r.body.includes("没识别到时间"), JSON.stringify(r.body).slice(0, 120));

  // 群通知里的原样文本：引号、换行、反斜杠都有，走 JSON 会坏，走纯文本必须能吞
  const messy = '【通知】"明天的实验课"调到 11月21日下午2点\n地点：教三-201\\请准时到场';
  r = await req(MPORT, "POST", "/api/share", { token: TOKEN, raw: messy });
  ok("脏文本（引号/换行/反斜杠）也能收", r.code === 200 && r.body.startsWith("记下了："), JSON.stringify(r.body).slice(0, 160));

  r = await req(MPORT, "POST", "/api/share", { token: TOKEN, raw: "   " });
  ok("空内容被拒", r.code === 400, "got " + r.code);

  // 测试造出来的任务要收干净，不能留在库里
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  for (const t of (JSON.parse(r.body).tasks || [])) {
    if (/实习鉴定表|实验课/.test(t.title || "")) {
      await req(MPORT, "POST", "/api/mobile/drop", { token: TOKEN, body: { id: t.id } });
    }
  }
  r = await req(MPORT, "GET", "/api/state", { token: TOKEN });
  ok("分享造的任务已清理", !(JSON.parse(r.body).tasks || []).some(t => /实习鉴定表|实验课/.test(t.title || "")));

  console.log("\n— 日历订阅 —");
  r = await req(MPORT, "GET", "/api/calendar.ics?days=60&t=" + encodeURIComponent(TOKEN));
  ok("日历能订阅", r.code === 200 && r.body.startsWith("BEGIN:VCALENDAR"), "got " + r.code);

  console.log("\n— 本机端口不受影响 —");
  r = await req(PORT, "GET", "/api/state");
  ok("本机侧不需要 token", r.code === 200, "got " + r.code);

  console.log("\n" + "=".repeat(40));
  console.log(`通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
