// 把一段人话通知解析成结构化任务。纯规则实现，不联网、不调模型。
// 设计原则：宁可判"信息不全"，也不猜日期。

const TZ = "Asia/Shanghai";

export function normalize(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const pad = n => String(n).padStart(2, "0");

export function shanghaiParts(ms = Date.now()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const o = {};
  for (const { type, value } of f.formatToParts(ms)) o[type] = value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute };
}

export function iso({ y, m, d, hh = 9, mm = 0 }) {
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+08:00`;
}

function fmtWhen(ms) {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: TZ, hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function weekdayOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
}

function addDays({ y, m, d }, days) {
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGIT[s[1]];
  if (/^[一二三四五六七八九]十$/.test(s)) return CN_DIGIT[s[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
  return CN_DIGIT[s] ?? null;
}

const DUE_WORDS = /截止|截至|到期|前提交|之前提交|DDL|deadline|最晚|务必在|前完成/i;
const START_WORDS = /开始|开考|上课|举行|开展|进行|集合|时间[:：]|定于|起/i;
const END_STRONG = /结束|散会|收卷|历时|止|完毕/i;
const END_WEAK = /至|到/;

function has(list, re) {
  return re.test(list);
}

// 判断某个日期/时刻属于哪个锚点。
// 顺序很关键：「考试时间：10-31 19:00 至 10-31 21:00」里，第一个日期附近
// 既有"时间："又有"至"，必须先认开始；"结束/收卷"这类强信号才优先于开始。
//
// 「到/至/-」不能一概当结束：它在时刻后面表示这是起点，在前面才是终点。
// 以前一刀切成 end，导致「19:00 至 21:00」被解析成 21:00 开始、19:00 结束。
function anchorNear(text, at, len) {
  const before = text.slice(Math.max(0, at - 14), at);
  const after = text.slice(at + len, Math.min(text.length, at + len + 14));
  const win = before + after;

  if (has(win, DUE_WORDS)) return "due";
  if (has(win, END_STRONG)) return "end";
  if (has(win, START_WORDS)) return "start";
  if (/^\s*(至|到|~|—|–|-)/.test(after)) return "start";
  if (/(至|到|~|—|–|-)\s*$/.test(before)) return "end";
  return null;
}

// 找出所有日期、时刻，附带在原文中的位置，便于判断它属于哪个锚点
function scanDates(text, now) {
  const marks = [];
  const taken = new Array(text.length).fill(false);
  const mark = (i, len) => { for (let k = i; k < i + len; k++) taken[k] = true; };
  const free = (i, len) => { for (let k = i; k < i + len; k++) if (taken[k]) return false; return true; };

  // 1. 完整日期 2026-11-10 / 2026年11月10日
  const reFull = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*[日号]?/g;
  for (const m of text.matchAll(reFull)) {
    const [s] = m;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    marks.push({ kind: "date", at: m.index, len: s.length, value: { y, m: mo, d }, absolute: true });
    mark(m.index, s.length);
  }

  // 2. 月日 11月10日 / 10-31（卡片式通知常见）
  const reMD = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g;
  for (const m of text.matchAll(reMD)) {
    const [s] = m;
    if (!free(m.index, s.length)) continue;
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    // 没写年份：取今年，若已过去则算明年
    let y = now.y;
    if (Date.UTC(y, mo - 1, d) < Date.UTC(now.y, now.m - 1, now.d) - 180 * 86400000) y += 1;
    marks.push({ kind: "date", at: m.index, len: s.length, value: { y, m: mo, d }, absolute: true });
    mark(m.index, s.length);
  }

  // 2b. 10-31 / 10/31 这种短日期（不带"月"字）。要避开 10:00-11:00 这类时间段
  const reDash = /(?<![\d:.])(\d{1,2})\s*[-/.]\s*(\d{1,2})(?![\d:])/g;
  for (const m of text.matchAll(reDash)) {
    const [s] = m;
    if (!free(m.index, s.length)) continue;
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let y = now.y;
    if (Date.UTC(y, mo - 1, d) < Date.UTC(now.y, now.m - 1, now.d) - 180 * 86400000) y += 1;
    marks.push({ kind: "date", at: m.index, len: s.length, value: { y, m: mo, d }, absolute: true });
    mark(m.index, s.length);
  }

  // 3. 相对日期
  const relMap = [
    [/大后天/, 3], [/后天/, 2], [/明天|明日/, 1], [/今天|今日/, 0]
  ];
  for (const [re, delta] of relMap) {
    const m = re.exec(text);
    if (m && free(m.index, m[0].length)) {
      marks.push({ kind: "date", at: m.index, len: m[0].length, value: addDays(now, delta), absolute: false });
      mark(m.index, m[0].length);
    }
  }

  // 4. 周几：本周五 / 下周三 / 周五
  const reWeek = /(上|下|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g;
  for (const m of text.matchAll(reWeek)) {
    const [s] = m;
    if (!free(m.index, s.length)) continue;
    const target = WEEKDAY[m[2]];
    const today = now;
    const todayW = weekdayOf(today.y, today.m, today.d);
    let diff = (target - todayW + 7) % 7;
    if (m[1] === "下") diff += 7;
    if (m[1] === "上") diff -= 7;
    const value = addDays(today, diff);
    marks.push({ kind: "date", at: m.index, len: s.length, value, absolute: false });
    mark(m.index, s.length);
  }

  // 5. 时刻 23:59 / 下午3点 / 下午两点半 / 晚上八点
  //    小时和分钟都可能是中文数字。以前只认阿拉伯数字，「下午两点」认不出来会掉到
  //    默认的 9:00，等于把下午的会议记成了早上 —— 这个错必须堵住。
  const CN_H = "零一二三四五六七八九十两";
  const reTime = new RegExp(
    `(凌晨|早上|上午|中午|下午|傍晚|晚上)?\\s*(\\d{1,2}|[${CN_H}]{1,3})\\s*[:点]\\s*(\\d{1,2}|半|[${CN_H}]{1,3})?\\s*分?`,
    "g"
  );
  const toNum = v => (/^\d+$/.test(v) ? +v : cnNumber(v));
  const timeMarks = [];
  for (const m of text.matchAll(reTime)) {
    const [s] = m;
    if (!free(m.index, s.length)) continue;
    const rawHh = toNum(m[2]);
    const mm = m[3] === "半" ? 30 : (m[3] ? toNum(m[3]) : 0);
    if (!Number.isFinite(rawHh) || !Number.isFinite(mm) || rawHh > 24 || mm > 59) continue;
    timeMarks.push({ at: m.index, len: s.length, rawHh, mm, period: m[1] || null });
    mark(m.index, s.length);
  }

  // 「下午三点到五点」—— 后面那个常常不写上午/下午，得跟着前面那个走。
  // 不继承的话「五点」会被当成早上五点，整段时间就错了。
  for (let i = 1; i < timeMarks.length; i++) {
    const cur = timeMarks[i];
    if (cur.period) continue;
    const prev = timeMarks[i - 1];
    if (!prev.period) continue;
    const gap = text.slice(prev.at + prev.len, cur.at);
    if (/^\s*[到至\-~—–]\s*$/.test(gap)) cur.period = prev.period;
  }

  for (const t of timeMarks) {
    let hh = t.rawHh;
    const period = t.period;
    if (["下午", "傍晚", "晚上"].includes(period) && hh < 12) hh += 12;
    if (period === "中午" && hh < 11) hh += 12;
    if (period === "凌晨" && hh === 12) hh = 0;
    if (hh === 24) hh = 0;
    marks.push({ kind: "time", at: t.at, len: t.len, value: { hh, mm: t.mm } });
  }

  return marks.sort((a, b) => a.at - b.at);
}

const DURATION_RE = /(?:预计|大约|约|时长)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(个)?\s*(小时|钟头|分钟|分)/;

function scanDuration(text) {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? +m[1] : cnNumber(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[3];
  const minutes = unit === "分钟" || unit === "分" ? n : n * 60;
  if (minutes < 1 || minutes > 60 * 24) return null;
  return Math.round(minutes);
}

// 「5 分钟后」「半小时后」「三天后」——没有钟点的相对时间。
// 以前这类句子一个时间都解析不出来，只能等模型；模型有时把它塞进 due，
// 提醒就排到错的位置上。这里先自己算成绝对时刻。
const REL_RE = /(\d+(?:\.\d+)?|[一二两三四五六七八九十]+|半)\s*(个)?\s*(秒钟?|分钟|分|小时|钟头|天|星期|周)\s*(?:之?后|以后|后)/;

function scanRelativeTime(text, nowMs) {
  const m = REL_RE.exec(text);
  if (!m) return null;
  const raw = m[1];
  const n = raw === "半" ? 0.5 : (/^\d/.test(raw) ? +raw : cnNumber(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[3];
  const unitMs = u.startsWith("秒") ? 1000
    : u === "天" ? 86400000
    : (u === "周" || u.startsWith("星") ? 7 * 86400000
    : (u.includes("时") || u === "钟头" ? 3600000 : 60000));
  const delta = Math.round(n * unitMs);
  if (delta < 10_000 || delta > 400 * 86400000) return null;
  return { at: m.index, len: m[0].length, ms: nowMs + delta, text: m[0] };
}

// 「提醒我」后面跟的才是要提醒的事，前面那截是时间
const ASK_REMIND = /提醒我|提醒一下|提醒下|记得提醒|叫我一下|喊我/;

function pickReminderText(text) {
  const m = /提醒我(?:一下|下)?\s*[，,、:]?\s*([\s\S]+)$/.exec(text);
  if (!m) return null;
  const s = m[1].replace(/^[，,、:\s]+/, "").trim();
  return s ? s.slice(0, 40) : null;
}

// 判断某个日期/时刻属于哪个锚点：看它附近有没有"截止/开始/结束"字样
// 图片 OCR 常把「考试」认成「考讠」这种只错一个字的形态。
// 类型判定因此做两层：精确包含算满分，差一个字的近似命中算六折。
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function fuzzyHit(text, keyword) {
  const k = String(keyword).trim();
  // 只对 3 字以上的词做近似匹配。2 字词太容易误伤：
  // 「小组讨论」和「小测」差一个字，但完全不是一回事。
  if (k.length < 3 || k.length > 8) return null;
  for (let i = 0; i + k.length <= text.length; i++) {
    const w = text.slice(i, i + k.length);
    if (lev(w, k) <= 1) return w;
  }
  return null;
}

export function parse(text, { rules = [], nowMs = Date.now() } = {}) {
  const clean = normalize(text);
  const now = shanghaiParts(nowMs);
  const notes = [];

  if (!clean) throw new Error("没有可解析的内容");

  // 类型判定：命中的关键词最多的那条规则胜出，同分看 priority
  const lower = clean.toLowerCase();
  let best = null;
  for (const rule of rules) {
    if (rule.isDefault) continue;
    const exact = (rule.match || []).filter(k => k && lower.includes(String(k).toLowerCase()));
    const near = [], nearFrom = [];
    for (const k of (rule.match || [])) {
      if (!k || exact.includes(k)) continue;
      const w = fuzzyHit(lower, String(k).toLowerCase());
      if (w) { near.push(k); nearFrom.push(`${w}≈${k}`); }
    }
    if (!exact.length && !near.length) continue;
    const score = exact.length * 10 + near.length * 6 + (rule.priority || 0) / 100;
    if (!best || score > best.score) best = { rule, hits: [...exact, ...near], exact, near, nearFrom, score };
  }
  const rule = best?.rule || rules.find(r => r.isDefault) || { name: "其他", defaultAnchor: "start", reminders: [{ anchor: "start", before: "1h" }] };
  if (!best) notes.push("没有匹配到已知类型，按「其他」处理");
  if (best && !best.exact.length && best.near.length) notes.push(`类型是按相近字猜的（${best.nearFrom.join("、")}），请核对`);

  // 「5 分钟后」这种相对时间先自己算掉，免得和后面的钟点/日期串味
  const relTime = scanRelativeTime(clean, nowMs);
  const asksRemind = ASK_REMIND.test(clean);
  const scanText = relTime
    ? clean.slice(0, relTime.at) + " ".repeat(relTime.len) + clean.slice(relTime.at + relTime.len)
    : clean;

  const marks = scanDates(scanText, now);
  const dates = marks.filter(m => m.kind === "date");
  const times = marks.filter(m => m.kind === "time");
  const duration = scanDuration(clean);

  // 组合：时刻优先配最近的日期；只有一个日期就都用它
  const slots = [];
  const usedTime = new Set();
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const next = dates[i + 1];
    const cand = times.find((t, idx) => !usedTime.has(idx) && t.at >= date.at && (!next || t.at < next.at));
    const chosen = cand || (i === 0 ? times.find((t, idx) => !usedTime.has(idx)) : null);
    if (chosen) usedTime.add(times.indexOf(chosen));
    const wall = { ...date.value, hh: chosen ? chosen.value.hh : 9, mm: chosen ? chosen.value.mm : 0 };
    slots.push({ ...wall, at: date.at, hasTime: Boolean(chosen), absolute: date.absolute, anchorHint: anchorNear(clean, date.at, date.len) });
  }

  // 剩下的时刻：一句里写了"14:00开始，15:40结束"时，第二个时刻要单独成一条
  for (let idx = 0; idx < times.length; idx++) {
    if (usedTime.has(idx)) continue;
    const t = times[idx];
    const hint = anchorNear(clean, t.at, t.len);
    const host = [...slots].filter(s => s.at <= t.at).pop() || slots[0];
    if (!host) continue;
    slots.push({ ...host, hh: t.value.hh, mm: t.value.mm, at: t.at, hasTime: true, anchorHint: hint });
  }
  slots.sort((a, b) => a.at - b.at);

  // 只有时刻没有日期：算今天/明天（时刻已过则算明天）
  if (!slots.length && times.length) {
    for (const t of times) {
      const wall = { ...now, hh: t.value.hh, mm: t.value.mm };
      let dt = new Date(iso(wall));
      if (dt.getTime() <= nowMs) dt = new Date(iso({ ...addDays(now, 1), hh: t.value.hh, mm: t.value.mm }));
      const p = shanghaiParts(dt.getTime());
      slots.push({ ...p, at: t.at, hasTime: true, absolute: false, anchorHint: anchorNear(clean, t.at, t.len) });
      notes.push("原文只给了时刻、没给日期，已按今天/明天推断，请核对");
    }
  }

  if (!slots.length) {
    notes.push("原文里找不到任何日期或时刻，需要你补一个时间");
  }

  // 分配到 start / end / due
  const value = { start: null, end: null, due: null };
  const assign = [];
  for (const s of slots) {
    if (s.anchorHint && !value[s.anchorHint]) { value[s.anchorHint] = s; assign.push([s.anchorHint, s]); }
    else assign.push([null, s]);
  }
  for (const [anchor, s] of assign) {
    if (anchor) continue;
    if (!value.start) { value.start = s; continue; }
    if (!value.end) { value.end = s; continue; }
    if (!value.due) { value.due = s; continue; }
  }

  // 兜底：按任务类型的默认锚点回填
  const defaultAnchor = rule.defaultAnchor || "start";
  if (defaultAnchor === "due" && !value.due && value.start) { value.due = value.start; value.start = null; }
  if (defaultAnchor === "start" && !value.start && value.due) { value.start = value.due; value.due = null; }

  // 有开始时间但没结束时间，用"预计 X 分钟"推算
  if (value.start && !value.end && duration) {
    const endMs = new Date(iso(value.start)).getTime() + duration * 60000;
    const p = shanghaiParts(endMs);
    value.end = { ...p, at: value.start.at, hasTime: true, absolute: value.start.absolute, derived: true };
    notes.push(`没有写结束时间，按「${duration} 分钟」推出结束时间`);
  }
  if (!value.start && value.due) {
    // 只有截止时间的作业：把截止时间当成锚点，start 留空
  }

  // 「5 分钟后开会」这种没写钟点的，直接落成开始时刻
  if (relTime && !asksRemind && !value.start && !value.due) {
    const p = shanghaiParts(relTime.ms);
    value.start = { ...p, at: relTime.at, hasTime: true, absolute: false };
    notes.push(`「${relTime.text}」按现在往后算，是 ${fmtWhen(relTime.ms)}`);
  }

  const toIso = s => (s ? iso(s) : null);
  let start = toIso(value.start);
  let end = toIso(value.end);
  const due = toIso(value.due);

  // 时段跨午夜时会出现「结束早于开始」：比如「晚上八点到十点」里八点已经过了被顺延到明天，
  // 十点还在今天。这种把结束时间推到开始之后，否则提醒会排不出来。
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    const p = shanghaiParts(Date.parse(end) + 86_400_000);
    const pad = n => String(n).padStart(2, "0");
    end = `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:00+08:00`;
    notes.push("结束时间早于开始，已按第二天处理");
  }

  // 标题：取第一行；如果第一行不含类型关键词（比如只写了班级号），把类型名带上
  const firstLine = clean.split("\n").map(l => l.trim()).filter(Boolean)[0] || clean;
  let title = firstLine
    .replace(/^[【\[][^】\]]{1,12}[】\]]\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (best && !best.hits.some(k => firstLine.includes(k))) title = `${rule.name}｜${title}`;

  // 时间全在过去：提前说一声，别让人以为能提醒
  const allPast = [start, end, due].filter(Boolean).every(v => Date.parse(v) < nowMs - 60_000)
    && [start, end, due].some(Boolean);
  if (allPast) notes.push("这条的时间已经过去了，排不出有效的提醒");

  // 「提醒我」= 用户要的是"到那个点叫我一声"，不是"围绕这件事排一串提前量"。
  // 判断很直接：说了提醒我，且整句只有一个时间点 —— 那就只响那一下。
  let remindAt = null;
  let remindOnly = false;
  let reminderText = null;
  if (asksRemind) {
    if (relTime) {
      remindAt = new Date(relTime.ms).toISOString();
      remindOnly = true;
    } else {
      const uniq = [...new Set([start, end, due].filter(Boolean).map(v => Date.parse(v)))];
      if (uniq.length === 1) { remindAt = new Date(uniq[0]).toISOString(); remindOnly = true; }
    }
    if (remindOnly) {
      reminderText = pickReminderText(clean);
      notes.push(`你说的是「提醒我」，到点响一次就够，不排提前量`);
    }
  }

  // 课程名：优先书名号/方括号里的内容
  const courseMatch = /[《【]([^》】]{1,20})[》】]/.exec(clean);

  let confidence = 0.15;
  if (slots.some(s => s.absolute)) confidence += 0.3;
  if (slots.some(s => s.hasTime)) confidence += 0.2;
  if (best) confidence += 0.25;
  if (value.start || value.due) confidence += 0.1;
  if (!slots.length) confidence = 0.2;
  confidence = Math.min(0.98, Math.round(confidence * 100) / 100);

  return {
    type: rule.id || rule.name || "other",
    typeName: rule.name || "其他",
    ruleFile: rule.file || null,
    title,
    course: courseMatch ? courseMatch[1] : null,
    start, end, due,
    remindAt, remindOnly, reminderText,
    durationMinutes: duration,
    location: null,
    confidence,
    needsInfo: !start && !due && !remindAt,
    notes,
    matchedKeywords: best?.hits || []
  };
}

export function parseBefore(str) {
  const s = String(str || "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*(d|day|天|h|hour|小时|m|min|分钟|分)$/i.exec(s);
  if (!m) throw new Error(`看不懂的时间偏移：${str}`);
  const n = +m[1];
  const u = m[2].toLowerCase();
  if (["d", "day", "天"].includes(u)) return n * 86400000;
  if (["h", "hour", "小时"].includes(u)) return n * 3600000;
  return n * 60000;
}

// 这件事大概持续多少分钟。用 start→end 算；算不出来再看解析时给的 durationMinutes。
// 规则里的 when 门槛靠它判断——比如「超过 1 小时的考试才在结束前半小时再叫一次」。
function taskMinutes(task) {
  const s = Date.parse(task.start || task.due || task.remindAt || "");
  const e = Date.parse(task.end || "");
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) return Math.round((e - s) / 60000);
  return Number(task.durationMinutes) || 0;
}

// 规则里可选的门槛。没写 when 就一律排；写了就都得满足。
function matchWhen(when, task) {
  if (!when || typeof when !== "object") return true;
  const mins = taskMinutes(task);
  if (when.minDuration != null && mins < Number(when.minDuration)) return false;
  if (when.maxDuration != null && mins > Number(when.maxDuration)) return false;
  return true;
}

export function expandReminders(task, rule, nowMs = Date.now()) {
  const out = [];
  const skipped = [];
  for (const r of rule.reminders || []) {
    // 带条件的提醒点（when）：不满足就静默跳过，不算「没排上」，
    // 否则每条 20 分钟的考试都会报一句「没排上 end 的提醒」，纯噪音。
    if (!matchWhen(r.when, task)) continue;
    const anchorIso = task[r.anchor];
    if (!anchorIso) {
      skipped.push({ anchor: r.anchor, reason: `缺「${anchorName(r.anchor)}」时间` });
      continue;
    }
    let offset;
    try { offset = r.after ? -parseBefore(r.after) : parseBefore(r.before); }
    catch { skipped.push({ anchor: r.anchor, reason: `规则写错了：${r.before || r.after}` }); continue; }
    const fireAt = new Date(Date.parse(anchorIso) - offset).toISOString();
    out.push({
      anchor: r.anchor,
      before: r.before || null,
      after: r.after || null,
      fireAt,
      text: r.text || defaultText(r, task, anchorIso)
    });
  }
  out.sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  return { reminders: out, skipped };
}

function anchorName(a) {
  return { start: "开始", end: "结束", due: "截止" }[a] || a;
}

function defaultText(r, task, anchorIso) {
  const when = new Date(anchorIso).toLocaleString("zh-CN", { timeZone: TZ, hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rel = r.before ? `还有 ${r.before}` : `已过 ${r.after}`;
  return `${task.title}｜${anchorName(r.anchor)}时间 ${when}（${rel}）`;
}
