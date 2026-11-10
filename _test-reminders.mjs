// 验证「改提醒时间」：原有固定提醒要保留，删掉的要真消失，加的要真排上。
// 用法：先用 TODO_DATA=./_tm-test 起服务，再 node _test-reminders.mjs
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("./_tm-test/config.json", "utf8"));
const BASE = "http://127.0.0.1:" + (process.env.TODO_MOBILE_PORT || cfg.mobile.port);
const H = { "X-Todo-Token": cfg.mobile.token, "Content-Type": "application/json" };

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  →  " + JSON.stringify(extra) : "")); }
}

async function state() {
  const r = await fetch(BASE + "/api/state", { headers: H });
  return r.json();
}
async function taskOf(id) {
  const s = await state();
  return s.tasks.find(t => t.id === id);
}
async function setPoints(id, points) {
  const r = await fetch(BASE + "/api/mobile/reminders", {
    method: "POST", headers: H, body: JSON.stringify({ id, points })
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
}
async function auto(id) {
  const r = await fetch(BASE + "/api/mobile/reminders", {
    method: "POST", headers: H, body: JSON.stringify({ id, mode: "auto" })
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
}
const iso = ms => new Date(ms).toISOString();
// fireAt 是 ISO 字符串，跟数字直接比等于 NaN，必须解析
const live = t => (t.reminders || [])
  .filter(r => r.status === "pending")
  .map(r => Date.parse(r.fireAt))
  .filter(x => Number.isFinite(x) && x > Date.now());

const RULE_ID = "13e54e8f";   // 有规则（_默认.json），起点 11-15 14:30
const Hw = "hw000001";        // 没规则、连时间都没有

console.log("\n[1] 有规则的任务：原有提醒默认保留");
// 先回到「全是规则排的」状态，这样脚本可以反复跑
await auto(RULE_ID);
let t = await taskOf(RULE_ID);
const origin = live(t);
ok(origin.length >= 2, "原本就排了 " + origin.length + " 个点", origin);

const tomorrow20 = (() => {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 0).getTime();
})();

// 只加一个点，原来那两点一个都不动
let r = await setPoints(RULE_ID, [...origin.map(iso), iso(tomorrow20)]);
ok(r.code === 200, "接口返回 200", r.body);
t = await taskOf(RULE_ID);
let now = live(t);
ok(now.length === origin.length + 1, "只加了 1 个，原有 " + origin.length + " 个全在", now);
ok(origin.every(x => now.includes(x)), "原有的固定提醒时间逐个还在", now);
ok(now.includes(tomorrow20), "新加的时间排上了");

console.log("\n[2] 幂等：同样内容再存一次，不该翻倍");
const before = live(t);
r = await setPoints(RULE_ID, before.map(iso));
t = await taskOf(RULE_ID);
ok(live(t).length === before.length, "数量不变（" + before.length + "）", live(t));
ok(t.extraReminders?.length === 1, "额外点只有 1 个，没有越存越多", t.extraReminders);

console.log("\n[3] 删掉其中一个：那个点要真的不再出现");
const keep = now.filter(x => x !== origin[0]);
r = await setPoints(RULE_ID, keep.map(iso));
t = await taskOf(RULE_ID);
const after3 = live(t);
ok(!after3.includes(origin[0]), "删掉的那个点没了", after3);
ok(keep.every(x => after3.includes(x)), "同批保留的点都还在", after3);
ok((t.mutedReminders || []).length >= 1, "被删的点记进 mutedReminders（规则重排也压得住）", t.mutedReminders);

console.log("\n[4] 没规则、没时间的任务：只按用户给的时间叫");
r = await setPoints(Hw, [iso(tomorrow20)]);
ok(r.code === 200, "接口返回 200", r.body);
t = await taskOf(Hw);
ok(live(t).length === 1, "排出 1 个提醒", live(t));
ok(live(t)[0] === tomorrow20, "时间就是用户设的那个", live(t));

const dayAfter = tomorrow20 + 86400000;
r = await setPoints(Hw, [iso(tomorrow20), iso(dayAfter)]);
t = await taskOf(Hw);
ok(live(t).length === 2, "再加一个 → 2 个", live(t));

console.log("\n[5] 不带时区的字符串按北京时间算（datetime-local 会给这种）");
// 用无规则任务试，避免被规则的点干扰
r = await setPoints(Hw, ["2026-11-20T20:00"]);
ok(r.code === 200, "接口返回 200", r.body);
t = await taskOf(Hw);
ok(t.reminders.some(x => x.status === "pending" && x.fireAt === "2026-11-20T12:00:00.000Z"),
  "20:00（+08:00）落成 12:00Z，没被当成 UTC", live(t));

console.log("\n[6] 恢复自动：回到规则排的那几个");
await setPoints(RULE_ID, [iso(tomorrow20)]);
t = await taskOf(RULE_ID);
ok(live(t).length === 1, "先改成只剩 1 个", live(t));
r = await auto(RULE_ID);
ok(r.code === 200, "接口返回 200", r.body);
t = await taskOf(RULE_ID);
ok(live(t).length === origin.length, "回到规则的 " + origin.length + " 个", live(t));
ok(origin.every(x => live(t).includes(x)), "时间跟原来一致", live(t));
ok(!t.extraReminders && !t.mutedReminders, "手动标记清干净了", { e: t.extraReminders, m: t.mutedReminders });

console.log("\n[7] 边界");
r = await setPoints("nope", [iso(tomorrow20)]);
ok(r.code === 404, "任务不存在 → 404", r.code);
r = await setPoints(RULE_ID, []);
ok(r.code === 200, "清空所有点 → 200", r.body);
t = await taskOf(RULE_ID);
ok(live(t).length === 0, "清空后确实一个都不剩", live(t));

const noToken = await fetch(BASE + "/api/mobile/reminders", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
});
ok(noToken.status === 401, "没密钥 → 401", noToken.status);

console.log("\n结果：" + pass + " 通过，" + fail + " 失败\n");
process.exit(fail ? 1 : 0);
