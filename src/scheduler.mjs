// 提醒调度：每 15 秒扫一次待发队列。
// 不在内存里搞堆，是因为补发逻辑比精度更重要：手机/电脑关过之后，
// 能清楚知道"哪些漏了、漏了多久"比省那点 CPU 值得多。

const RESEND_WINDOW_MS = 30 * 60 * 1000; // 迟到 30 分钟内：立即补发
const TICK_MS = 15 * 1000;

export class Scheduler {
  constructor({ store, notify, onEvent = () => {} }) {
    this.store = store;
    this.notify = notify;
    this.onEvent = onEvent;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => this.onEvent({ type: "tick-error", error: err.message })), TICK_MS);
    this.tick().catch(err => this.onEvent({ type: "tick-error", error: err.message }));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 启动时先把积压的处理掉：近的补发，远的汇总成一条"错过了"
  async catchUp() {
    const now = Date.now();
    const overdue = this.store.reminders
      .filter(r => r.status === "pending" && Date.parse(r.fireAt) <= now)
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
    if (!overdue.length) return { resent: 0, missed: 0 };

    const recent = overdue.filter(r => now - Date.parse(r.fireAt) <= RESEND_WINDOW_MS);
    const stale = overdue.filter(r => now - Date.parse(r.fireAt) > RESEND_WINDOW_MS);

    for (const r of recent) await this.fire(r, { late: true });
    if (stale.length) {
      for (const r of stale) this.store.markReminder(r.id, "missed", { missedAt: new Date().toISOString() });
      const titles = stale.slice(0, 5).map(r => this.taskTitle(r.taskId)).filter(Boolean);
      await this.notify({
        title: `错过了 ${stale.length} 条提醒`,
        body: titles.join("、") + (stale.length > 5 ? " 等" : ""),
        kind: "digest"
      });
      this.store.addInbox({ kind: "digest", count: stale.length, titles });
    }
    await this.store.flush();
    return { resent: recent.length, missed: stale.length };
  }

  taskTitle(taskId) {
    return this.store.tasks.find(t => t.id === taskId)?.title || "";
  }

  async fire(reminder, { late = false } = {}) {
    const task = this.store.tasks.find(t => t.id === reminder.taskId);
    const title = task?.title || "提醒";
    const when = new Date(reminder.fireAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const body = `${reminder.text || ""}${reminder.text ? "\n" : ""}${when}${late ? "（补发）" : ""}`;
    try {
      // notify 不抛异常，各通道结果挂在返回值上：qq / webhook 是 "ok" | "skip" | 错误串。
      // 全挂了就不能算 sent，否则界面上写着"已发出"、手机上一声不响，比不提醒更坑。
      const sent = await this.notify({ title, body, kind: "reminder", taskId: reminder.taskId });
      const qq = sent?.qq ?? "-";
      const webhook = sent?.webhook ?? "-";
      const toastOk = sent?.toast ?? false;
      const okCount = [qq === "ok", webhook === "ok", toastOk].filter(Boolean).length;
      const detail = { sentAt: new Date().toISOString(), late, qq, webhook };
      if (okCount === 0) {
        // 一条都没出去，说明是网络/接口抖动，留着再试；连着 3 次都不行才认输
        const attempts = (reminder.attempts || 0) + 1;
        const canRetry = attempts < 3 && Date.now() - Date.parse(reminder.fireAt) <= RESEND_WINDOW_MS;
        this.store.markReminder(reminder.id, canRetry ? "pending" : "error", {
          ...detail,
          attempts,
          error: `所有通道都没发出去（qq=${qq} webhook=${webhook}）`
        });
        this.onEvent({ type: canRetry ? "reminder-retry" : "reminder-error", id: reminder.id, qq, webhook, attempts });
      } else {
        this.store.markReminder(reminder.id, "sent", detail);
        this.onEvent({ type: "reminder-sent", id: reminder.id, title, qq, webhook });
      }
      this.store.addInbox({ kind: "reminder", title, body, sentAt: new Date().toISOString(), qq, webhook });
    } catch (err) {
      this.store.markReminder(reminder.id, "error", { error: err.message });
      this.onEvent({ type: "reminder-error", id: reminder.id, error: err.message });
    }
    await this.store.flush();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.store.reminders
        .filter(r => r.status === "pending" && Date.parse(r.fireAt) <= now)
        .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
      for (const r of due) {
        if (now - Date.parse(r.fireAt) > RESEND_WINDOW_MS) {
          this.store.markReminder(r.id, "missed", { missedAt: new Date().toISOString() });
          continue;
        }
        await this.fire(r, { late: now - Date.parse(r.fireAt) > 60_000 });
      }
      if (due.length) await this.store.flush();
    } finally {
      this.running = false;
    }
  }

  next() {
    const pending = this.store.reminders
      .filter(r => r.status === "pending")
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
    return pending[0] || null;
  }
}
