import { buildIcs } from "./src/ics.mjs";

const ics = buildIcs([
  { uid: "abc123", at: Date.parse("2026-11-15T14:30:00+08:00"), title: "全体成员培训", body: "地点：三教201", alarms: [60, 0] },
  { uid: "def456", at: Date.parse("2026-11-20T23:59:00+08:00"), title: "高数作业截止", alarms: [1440, 0] }
], { name: "待办提醒" });

console.log(ics);
const checks = [
  ["事件只有两条", (ics.match(/BEGIN:VEVENT/g) || []).length === 2],
  ["培训有两个闹钟", /SUMMARY:全体成员培训[\s\S]*?BEGIN:VALARM[\s\S]*?TRIGGER:-PT60M[\s\S]*?BEGIN:VALARM[\s\S]*?TRIGGER:PT0M[\s\S]*?END:VEVENT/.test(ics)],
  ["提前一天是 -PT1440M", ics.includes("TRIGGER:-PT1440M")],
  ["时间为 UTC(14:30+08 → 06:30Z)", ics.includes("DTSTART:20261115T063000Z")],
  ["UID 固定", ics.includes("UID:abc123@todo-reminder")],
  ["CRLF 换行", ics.includes("\r\n")],
  ["有 DESCRIPTION 地点", ics.includes("地点：三教201")]
];
let pass = 0;
for (const [name, ok] of checks) { console.log(ok ? "✅" : "❌", name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
