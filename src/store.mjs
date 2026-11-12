import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// 所有数据落一个 JSON 文件，够用且方便你直接打开看。
export class Store {
  constructor(file) {
    this.file = file;
    this.tasks = [];
    this.reminders = [];
    this.inbox = [];
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const data = JSON.parse(raw);
      this.tasks = data.tasks || [];
      this.reminders = data.reminders || [];
      this.inbox = data.inbox || [];
    } catch {
      await this.flush();
    }
  }

  async flush() {
    await writeFile(this.file, JSON.stringify({
      tasks: this.tasks, reminders: this.reminders, inbox: this.inbox.slice(-200)
    }, null, 2), "utf8");
  }

  addTask(task) {
    const full = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...task };
    this.tasks.unshift(full);
    return full;
  }

  addReminders(taskId, list) {
    const created = list.map(r => ({
      id: randomUUID().slice(0, 8),
      taskId,
      status: "pending",
      ...r
    }));
    this.reminders.push(...created);
    return created;
  }

  remindersOf(taskId) {
    return this.reminders.filter(r => r.taskId === taskId).sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  }

  dropTask(taskId) {
    this.tasks = this.tasks.filter(t => t.id !== taskId);
    this.reminders = this.reminders.filter(r => r.taskId !== taskId);
  }

  // 手机上误点「删掉」的代价太高：整条任务连着提醒一起消失，日志里只剩一个标题，
  // 想捞回来只能手工重建。所以手机端不走 dropTask，改成打个删除标记 ——
  // 任务和提醒都还在库里，只是不再出现在列表里、提醒全部静音，随时能捡回来。
  trashTask(taskId) {
    const t = this.tasks.find(x => x.id === taskId);
    if (!t) return null;
    t.deletedAt = Date.now();
    for (const r of this.reminders) {
      if (r.taskId === taskId && r.status === "pending") r.status = "muted";
    }
    return t;
  }

  restoreTask(taskId) {
    const t = this.tasks.find(x => x.id === taskId);
    if (!t || !t.deletedAt) return null;
    delete t.deletedAt;
    const now = Date.now();
    let back = 0;
    for (const r of this.reminders) {
      if (r.taskId !== taskId || r.status !== "muted") continue;
      // 只点亮还没到点的那些。已经过去的时间点捞回来也没意义，
      // 反而会在下一次 flush 后突然补发一堆过期提醒。
      if (Date.parse(r.fireAt) > now) { r.status = "pending"; back++; }
    }
    return { task: t, back };
  }

  markReminder(id, status, extra = {}) {
    const r = this.reminders.find(x => x.id === id);
    if (!r) return null;
    Object.assign(r, { status, ...extra });
    return r;
  }

  addInbox(entry) {
    this.inbox.push({ at: new Date().toISOString(), ...entry });
    if (this.inbox.length > 200) this.inbox = this.inbox.slice(-200);
  }
}
