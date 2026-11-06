// 提醒点生成的回归测试。「超过 1 小时的考试要在结束前半小时也提醒一次」这条
// 是新加的条件规则，最容易回退，单独盯住。
//
// 跑法：node _test-alarms.mjs

import { readFile } from "node:fs/promises";
import { expandReminders } from "./src/parser.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const rule = JSON.parse(await readFile(new URL("./rules/考试.json", import.meta.url), "utf8"));
const fmt = iso => iso.slice(11, 16);   // HH:MM（ISO 里是 UTC，下面只看数量和时间差）

const base = { title: "高等数学 期中考试", start: "2026-12-05T19:00:00+08:00" };

console.log("1. 90 分钟的考试应该有 4 个提醒点（含结束前半小时）");
{
  const task = { ...base, end: "2026-12-05T20:30:00+08:00" };
  const { reminders } = expandReminders(task, rule);
  ok("4 个点", reminders.length === 4, `实际 ${reminders.length} 个：${reminders.map(r => r.text).join(" / ")}`);
  const has30 = reminders.some(r => r.anchor === "end" && r.before === "30m");
  ok("有「结束前 30 分钟」这个点", has30, reminders.map(r => `${r.anchor}:${r.before}`).join(","));
}

console.log("2. 20 分钟的考试不该有这个点");
{
  const task = { ...base, start: "2026-11-06T18:05:00+08:00", end: "2026-11-06T18:25:00+08:00" };
  const { reminders } = expandReminders(task, rule);
  ok("只有 3 个点", reminders.length === 3, `实际 ${reminders.length} 个`);
  ok("没有提前报「没排上」", !reminders.some(r => r.anchor === "end"));
}

console.log("3. 没有结束时间时不能凭空算「结束前半小时」");
{
  const task = { ...base };
  const { reminders, skipped } = expandReminders(task, rule);
  ok("仍然是 3 个点", reminders.length === 3, `实际 ${reminders.length}`);
  ok("不因为缺 end 就报错", skipped.length === 0, JSON.stringify(skipped));
}

console.log("4. 正好 60 分钟边界（包含）");
{
  const task = { ...base, start: "2026-12-05T19:00:00+08:00", end: "2026-12-05T20:00:00+08:00" };
  const { reminders } = expandReminders(task, rule);
  ok("60 分钟也算「超过…含」→ 4 个点", reminders.length === 4, `实际 ${reminders.length}`);
}

console.log("5. 没有时长信息（durationMinutes=0）不触发");
{
  const task = { ...base, durationMinutes: 0 };
  const { reminders } = expandReminders(task, rule);
  ok("3 个点", reminders.length === 3, `实际 ${reminders.length}`);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
