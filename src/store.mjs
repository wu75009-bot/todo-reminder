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
