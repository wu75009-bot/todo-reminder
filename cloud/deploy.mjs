// 一次性部署：建云函数 + 每分钟定时触发器，并把当前队列推上去。
// 用法：node cloud/deploy.mjs
import { readFile } from "node:fs/promises";
import { ensure, invokeTest } from "../src/scf.mjs";

const cfg = JSON.parse(await readFile(new URL("../data/config.json", import.meta.url), "utf8")).cloud;
const db = JSON.parse(await readFile(new URL("../data/db.json", import.meta.url), "utf8"));

const now = Date.now();
const until = now + (Number(cfg.days) > 0 ? Number(cfg.days) : 7) * 86400000;
const tasks = new Map((db.tasks || []).map(t => [t.id, t]));

const queue = (db.reminders || [])
  .filter(r => r.status === "pending")
  .map(r => ({ r, at: Date.parse(r.fireAt) }))
  .filter(x => Number.isFinite(x.at) && x.at > now - 60000 && x.at <= until)
  .sort((a, b) => a.at - b.at)
  .map(({ r, at }) => {
    const t = tasks.get(r.taskId);
    return {
      id: r.id,
      at,
      title: String(t?.title || r.text || "提醒").slice(0, 80),
      body: r.text && r.text !== t?.title ? r.text : ""
    };
  });

console.log(`待推队列 ${queue.length} 条`);
for (const q of queue.slice(0, 10)) {
  console.log("  ", new Date(q.at).toLocaleString("zh-CN", { hour12: false }), q.title);
}

const r = await ensure(cfg, queue);
console.log("部署结果：", JSON.stringify(r));

const t = await invokeTest(cfg);
console.log("手工触发：", JSON.stringify(t.ret));
