// 把待发的提醒导出成手机日历（.ics）。
// 为什么需要这个：QQ 推送依赖电脑开机，电脑一关就没人发。
// 导进手机日历之后是天生的本地闹钟，飞行模式也照样响，这是唯一
// 完全不依赖网络和这台机器的提醒方式。

const pad = n => String(n).padStart(2, "0");

// 日历里一律用 UTC（Z 结尾），客户端自己会转成本地时间。
// 直接写本地时间还要带 VTIMEZONE，容易在不同手机上错一小时。
export function icsTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 要求单行不超过 75 字节，超了要折行（续行以一个空格开头）。
// 中文一个字 3 字节，所以按字节数切，不能按字符数。
function fold(line) {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= 73) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > 73) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

/**
 * 生成 .ics。
 *
 * items 有两种形状：
 *   1) { at, title, alarms: [分钟数, ...], uid?, body? } —— 一条事件多个闹钟（推荐）
 *      alarms 里正数表示「提前多少分钟」，0 表示到点，负数表示事件之后。
 *   2) { fireAt, title, body?, id? } —— 一个提醒点一条事件（老形状，仍兼容）
 *
 * 为什么要按事件合并闹钟：一件事有「提前 1 小时」和「到点」两个提醒点，
 * 如果各生成一条 VEVENT，导进手机日历就是一个日程重复两遍 —— 用户在列表里
 * 看到两条一样的事，只会以为软件坏了。
 *
 * @param {Array<object>} items
 * @param {{name?: string, durationMinutes?: number}} opts
 */
export function buildIcs(items, opts = {}) {
  const name = opts.name || "待办提醒";
  const dur = (opts.durationMinutes || 10) * 60_000;
  const now = Date.now();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TodoReminder//TODO-ICS 1.0//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-WR-TIMEZONE:Asia/Shanghai"
  ];

  for (const it of items) {
    // at / fireAt 可能是 ISO 字符串，也可能是毫秒数（内部按毫秒传更省事）
    const raw = it.at ?? it.fireAt;
    const at = typeof raw === "number" ? raw : Date.parse(raw);
    if (!Number.isFinite(at)) continue;

    const title = (it.title || "提醒").slice(0, 100);
    const uid = it.uid || it.id || Math.random().toString(36).slice(2);
    const alarms = Array.isArray(it.alarms) && it.alarms.length ? it.alarms : [0];

    // 有真实结束时间就用它（培训 14:30-17:30 就该画满三小时），没有才给默认时长
    const rawEnd = it.end;
    const endAt = typeof rawEnd === "number" ? rawEnd : Date.parse(rawEnd || "");
    const end = Number.isFinite(endAt) && endAt > at ? endAt : at + dur;

    lines.push(
      "BEGIN:VEVENT",
      // UID 按任务固定，重复导出再导入是「更新同一条」，不会变成两条
      `UID:${uid}@todo-reminder`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(at)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${esc(title)}`,
      it.body ? `DESCRIPTION:${esc(it.body)}` : null
    );

    for (const mins of alarms) {
      const m = Number(mins);
      if (!Number.isFinite(m)) continue;
      const trigger = m === 0 ? "PT0M" : m > 0 ? `-PT${Math.round(m)}M` : `PT${Math.round(-m)}M`;
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${esc(title)}`,
        `TRIGGER:${trigger}`,
        "END:VALARM"
      );
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).map(fold).join("\r\n") + "\r\n";
}
