// 一次性补救脚本：把 11-12 误删的两条任务放回库里。
// 数据来源：
//   「全体成员培训」来自 /root/todo-reminder/data/db.json 的旧副本（原 id、原起止时间）；
//   「灭火实操培训」来自 11-06 的 QQ 通知原文 + 当时的 update_task 记录（14:50-15:35，提醒 13:50/14:50）。
// 只在服务停止时跑，跑完再启动 —— 服务在内存里有一份 db，边跑边改会被它覆盖。
import { readFile, writeFile, copyFile } from "node:fs/promises";

const FILE = process.argv[2] || "/opt/todo-reminder/data/db.json";
const db = JSON.parse(await readFile(FILE, "utf8"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await copyFile(FILE, `${FILE}.bak-${stamp}`);

const T = (o) => ({
  type: "_默认", typeName: "其他", ruleFile: "_默认.json",
  course: null, due: null, remindAt: null, remindOnly: false, reminderText: null,
  confidence: 0.9, needsInfo: false, matchedKeywords: [], engine: "model",
  ...o
});

const notice = `@全体成员
【灭火实操培训】为增强我校新生的消防安全意识，提高初起火灾的扑救处置的自防自救能力，根据学校年度消防安全工作计划安排，现集中组织开展2025级原江阴校区全体新生灭火技能培训活动。
培训地点：谊园培训点
培训内容：灭火器、灭火毯使用实操培训
具体时间安排暂定如下：
11月18日 14:00-14:45 ：3301、3302、7801、7805、7806班
11月18日 14:50-15:35  :  7807、7808、7809、7810班
11月19日 14:00-14:45  :  7802、7803、7804班
若当天下雨培训取消，另行通知。若有特殊情况需要请假，请提前一天向我报备。`;

const tasks = [
  T({
    id: "13e54e8f",
    createdAt: "2026-11-04T15:30:01.279Z",
    title: "全体成员培训",
    start: "2026-11-15T14:30:00+08:00",
    end: "2026-11-15T17:30:00+08:00",
    location: null,
    notes: ["11月15日 14:30-17:30，全体成员培训", "误删后按原数据恢复"],
    raw: "11.15日下午2.30-5.30，全体成员培训",
    rawText: "11.15日下午2.30-5.30，全体成员培训",
    source: "恢复"
  }),
  T({
    id: "e1e9e5aa",
    createdAt: "2026-11-06T13:05:26.000Z",
    title: "灭火实操培训",
    start: "2026-11-18T14:50:00+08:00",
    end: "2026-11-18T15:35:00+08:00",
    durationMinutes: 45,
    location: "谊园培训点",
    notes: ["7808 班：11月18日 14:50-15:35，谊园培训点", "灭火器、灭火毯实操", "误删后按原通知恢复"],
    raw: notice,
    source: "恢复"
  })
];

const fires = {
  "13e54e8f": ["2026-11-15T05:30:00.000Z", "2026-11-15T06:30:00.000Z"], // 13:30 / 14:30 (+08)
  "e1e9e5aa": ["2026-11-18T05:50:00.000Z", "2026-11-18T06:50:00.000Z"]  // 13:50 / 14:50 (+08)
};

const ids = new Set(tasks.map(t => t.id));
db.tasks = tasks.concat((db.tasks || []).filter(t => !ids.has(t.id)));
db.reminders = (db.reminders || []).filter(r => !ids.has(r.taskId));

const now = Date.now();
let added = 0;
for (const t of tasks) {
  for (const at of fires[t.id]) {
    if (Date.parse(at) <= now) continue;   // 已经过去的时间点别再补，否则一启动就补发一堆
    db.reminders.push({ id: Math.random().toString(16).slice(2, 10), taskId: t.id, fireAt: at, status: "pending" });
    added++;
  }
}

await writeFile(FILE, JSON.stringify(db, null, 2), "utf8");
console.log("恢复完成：任务 " + db.tasks.length + " 条，补回提醒 " + added + " 个，备份 db.json.bak-" + stamp);
for (const t of db.tasks) console.log(" -", t.id, t.title, t.start || t.due || "无时间", t.deletedAt ? "[回收站]" : "");
