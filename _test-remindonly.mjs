// 「提醒我」句式的回归测试：那个时间点必须原样成为提醒时刻，不排提前量。
// 跑：node _test-remindonly.mjs
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, expandReminders } from "./src/parser.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const rules = [];
for (const f of await readdir(join(ROOT, "rules"))) {
  if (!f.endsWith(".json")) continue;
  const r = JSON.parse(await readFile(join(ROOT, "rules", f), "utf8"));
  rules.push({ ...r, file: f });
}

// 固定"现在"：2026-11-04 22:05:00 +08:00
const NOW = Date.parse("2026-11-04T22:05:00+08:00");
const at = iso => Date.parse(iso);
const hhmm = ms => new Date(ms).toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit"
});

const cases = [
  {
    text: "5分钟后提醒我喝水",
    want: { remindOnly: true, remindAt: "2026-11-04T22:10:00+08:00", reminderText: "喝水" }
  },
  {
    text: "半小时后提醒我给妈妈打电话",
    want: { remindOnly: true, remindAt: "2026-11-04T22:35:00+08:00", reminderText: "给妈妈打电话" }
  },
  {
    text: "两小时后提醒我关火",
    want: { remindOnly: true, remindAt: "2026-11-05T00:05:00+08:00", reminderText: "关火" }
  },
  {
    text: "明天早上8点提醒我交电费",
    want: { remindOnly: true, remindAt: "2026-11-05T08:00:00+08:00", reminderText: "交电费" }
  },
  {
    // 不是"提醒我"，是事件 —— 该走提前量模板，不能被当成 remindOnly
    text: "22点40分开班会",
    want: { remindOnly: false }
  },
  {
    // 有提醒语气但写了开始和结束两个时间：不是一句话里唯一时刻，保持事件语义
    text: "明天14点到16点提醒我开会",
    want: { remindOnly: false }
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  const p = parse(c.text, { rules, nowMs: NOW });
  const rule = rules.find(r => r.name === p.typeName) || rules.find(r => r.isDefault);
  const { reminders } = expandReminders(p, rule, NOW);

  let planned;
  if (p.remindOnly) {
    planned = [{ fireAt: p.remindAt, text: p.reminderText || p.title }];
  } else {
    planned = reminders.filter(r => at(r.fireAt) > NOW - 60_000);
  }

  const problems = [];
  if (c.want.remindOnly !== undefined && p.remindOnly !== c.want.remindOnly) {
    problems.push(`remindOnly=${p.remindOnly} 期望 ${c.want.remindOnly}`);
  }
  if (c.want.remindAt && at(p.remindAt) !== at(c.want.remindAt)) {
    problems.push(`remindAt=${hhmm(at(p.remindAt))} 期望 ${hhmm(at(c.want.remindAt))}`);
  }
  if (c.want.reminderText && p.reminderText !== c.want.reminderText) {
    problems.push(`reminderText=${JSON.stringify(p.reminderText)} 期望 ${JSON.stringify(c.want.reminderText)}`);
  }
  if (c.want.remindOnly && planned.length !== 1) {
    problems.push(`应该只排 1 条提醒，实际 ${planned.length} 条`);
  }
  if (c.want.remindOnly && planned.length === 1 && planned[0].fireAt !== p.remindAt) {
    problems.push(`提醒时刻 ${hhmm(at(planned[0].fireAt))} 和要提醒的点对不上`);
  }

  if (problems.length) {
    fail++;
    console.log(`✗ ${c.text}`);
    for (const x of problems) console.log(`    ${x}`);
  } else {
    pass++;
    const detail = p.remindOnly
      ? `→ ${hhmm(at(p.remindAt))} 响「${p.reminderText}」`
      : `→ ${planned.map(r => hhmm(at(r.fireAt)) + " " + r.text).join(" | ") || "无提醒"}`;
    console.log(`✓ ${c.text}  ${detail}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
