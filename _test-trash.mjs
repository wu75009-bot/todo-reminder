// 回归：误删要能捡回来，列表里也要立刻消失。
// 先起服务：TODO_DATA=.../_tm-test node src/server.mjs
const BASE = "http://127.0.0.1:3979";
const H = { "X-Todo-Token": "TESTTOKEN0000000", "Content-Type": "application/json" };
let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg, extra === undefined ? "" : JSON.stringify(extra)); }
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};
const state = async () => (await fetch(BASE + "/api/state", { headers: H })).json();

const s0 = await state();
const target = (s0.tasks || [])[0];
ok(!!target, "有一条可以删的任务", s0.tasks?.length);

console.log("\n[1] 删掉：列表里消失，但库里还在");
let r = await post("/api/mobile/drop", { id: target.id });
ok(r.code === 200, "删除返回 200", r);
let s1 = await state();
ok(!(s1.tasks || []).some(t => t.id === target.id), "列表里看不到这条了");

const fs = await import("node:fs/promises");
const db = JSON.parse(await fs.readFile("C:/Users/likaicheng/Desktop/workbuddy/待办提醒/_tm-test/db.json", "utf8"));
const kept = db.tasks.find(t => t.id === target.id);
ok(!!kept, "库里还留着这条（打了删除标记）", db.tasks.length);
ok(kept && Number.isFinite(kept.deletedAt), "标记是删除时间", kept?.deletedAt);
const rs = db.reminders.filter(x => x.taskId === target.id);
ok(rs.length > 0 && rs.every(x => x.status === "muted"), "提醒还在，只是静音了", rs.map(x => x.status));

console.log("\n[2] 撤销：原样回来");
r = await post("/api/mobile/restore", { id: target.id });
ok(r.code === 200, "恢复返回 200", r);
ok(r.body.restored > 0, "重新点亮了未来提醒", r.body.restored);
let s2 = await state();
const back = (s2.tasks || []).find(t => t.id === target.id);
ok(!!back, "列表里又出现了");
ok(back && !back.deletedAt, "删除标记清掉了", back?.deletedAt);
ok((back?.reminders || []).filter(x => x.status === "pending").length === r.body.restored, "点亮数量和返回一致",
  (back?.reminders || []).map(x => x.status));

console.log("\n[3] 边界");
r = await post("/api/mobile/restore", { id: target.id });
ok(r.code === 404, "没删过的再恢复 → 404", r.code);
r = await post("/api/mobile/restore", { id: "ffffffff" });
ok(r.code === 404, "不存在的 id → 404", r.code);
r = await post("/api/mobile/drop", { id: "ffffffff" });
ok(r.code === 404, "删不存在的 id → 404", r.code);

const noToken = await fetch(BASE + "/api/mobile/restore", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: target.id })
});
ok(noToken.status === 401, "没密钥 → 401", noToken.status);

console.log("\n结果：" + pass + " 通过，" + fail + " 失败\n");
process.exit(fail ? 1 : 0);
