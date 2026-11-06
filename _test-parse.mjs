import { parse, expandReminders } from "./src/parser.mjs";
import { RuleBook } from "./src/rules.mjs";

const rules = await new RuleBook("./rules").load();

const cases = [
  "班级11322060D10\n考试时间：10-31 19:00 至 10-31 21:00",
  "班级11322060D10\n考试时间：11-18 19:00 至 11-18 21:00",
  "【高等数学】实验报告于11月10日23:59前提交到教学平台，逾期不候。",
  "物理小测安排：本周四下午2:00开始，15:40结束，地点教三302。",
  "周五下午3点在教三302开班会，请务必参加。",
  "下周要交物理实验报告",
  "11月20日 14:00 高数期末考试，考场 A101",
  "明天晚上8点半小组讨论项目，预计90分钟",
  "10:00-11:30 自习"
];

for (const text of cases) {
  const p = parse(text, { rules });
  const rule = rules.find(r => r.id === p.type) || rules.find(r => r.name === p.typeName);
  const ex = rule ? expandReminders(p, rule) : { reminders: [], skipped: [] };
  console.log("\n=== " + text.replace(/\n/g, " ⏎ "));
  console.log(`类型=${p.typeName}  标题=${p.title}  把握=${p.confidence}  缺时间=${p.needsInfo}`);
  console.log(`start=${p.start}  end=${p.end}  due=${p.due}`);
  if (p.notes.length) console.log("备注: " + p.notes.join(" | "));
  for (const r of ex.reminders) {
    const when = new Date(r.fireAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    console.log(`  → ${when}  ${r.anchor}  ${r.text}`);
  }
  if (ex.skipped.length) console.log("  排不上: " + ex.skipped.map(s => s.reason).join("、"));
}
