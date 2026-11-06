import { readFile } from "node:fs/promises";

// OneBot v11（NapCat 走的就是这套）最小客户端：
// 只做三件事——发私聊、取合并转发、拉图片。
// 不引依赖，全靠 fetch。

const DEFAULT_API = "http://127.0.0.1:3000";

export function qqConfig(raw) {
  const c = { ...(raw || {}) };
  c.api = String(c.api || DEFAULT_API).trim().replace(/\/+$/, "") || DEFAULT_API;
  c.token = String(c.token || "").trim();
  c.owner = String(c.owner || "").replace(/\D/g, "");
  c.bot = String(c.bot || "").replace(/\D/g, "");
  c.enabled = Boolean(c.enabled) && Boolean(c.owner);
  // 群：留空等于「哪个群 @ 我都回」，填了就只认这几个群
  c.groups = (Array.isArray(c.groups) ? c.groups : [])
    .map(g => String(g).replace(/\D/g, ""))
    .filter(Boolean);
  // silent=只在被 @ 时说话；smart=被 @、被点名、有人提问才接（默认）；chatty=都交给模型自己判断
  c.groupMode = ["silent", "smart", "chatty"].includes(c.groupMode) ? c.groupMode : "smart";
  // 0 = 不限制（用户可能明确要求「别设上限」），没填才用默认值
  const cd = Number(c.groupCooldownMs);
  c.groupCooldownMs = Number.isFinite(cd) && cd >= 0 ? cd : 90_000;
  const cap = Number(c.groupMaxPerHour);
  c.groupMaxPerHour = Number.isFinite(cap) && cap >= 0 ? cap : 12;
  // 叫它这些名字也算在叫它。单字名字（比如昵称就是个「。」）放进来的话会句句命中，一律丢掉。
  c.botAlias = (Array.isArray(c.botAlias) ? c.botAlias : [])
    .map(s => String(s).trim())
    .filter(s => s.length >= 2);
  return c;
}

async function call(cfg, action, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.api}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `NapCat 返回 HTTP ${res.status}`, data: json };
    if (json && (json.status === "failed" || json.retcode > 0)) {
      return { ok: false, error: json.message || json.wording || `retcode ${json.retcode}`, data: json };
    }
    return { ok: true, data: json?.data };
  } catch (err) {
    const msg = err.name === "AbortError" ? "连不上 NapCat（超时）" : err.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function sendPrivate(cfg, text) {
  if (!cfg.owner) return Promise.resolve({ ok: false, skipped: true, error: "还没填你的 QQ 号" });
  return call(cfg, "send_private_msg", {
    user_id: Number(cfg.owner),
    message: [{ type: "text", data: { text: String(text).slice(0, 1800) } }]
  });
}

// 发文件（比如日历 .ics）。file 用本机绝对路径，NapCat 会自己读上来。
export function sendPrivateFile(cfg, filePath, name) {
  if (!cfg.owner) return Promise.resolve({ ok: false, skipped: true, error: "还没填你的 QQ 号" });
  return call(cfg, "upload_private_file", {
    user_id: Number(cfg.owner),
    file: filePath,
    name: name || "file"
  }, 60000);
}

export function sendGroup(cfg, groupId, text) {
  if (!groupId) return Promise.resolve({ ok: false, skipped: true, error: "没有群号" });
  return call(cfg, "send_group_msg", {
    group_id: Number(groupId),
    message: [{ type: "text", data: { text: String(text).slice(0, 1800) } }]
  });
}

export function groupList(cfg) {
  return call(cfg, "get_group_list", {}, 10000);
}

export function groupMemberList(cfg, groupId) {
  return call(cfg, "get_group_member_list", { group_id: Number(groupId) }, 12000);
}

// 群名片缓存：gid -> { at, map: Map<qq, 名字> }
// 以前 @ 段被整个丢掉，群里「@某某 这个」到模型那里只剩「 这个」，
// 它当然不知道在说谁，只能回一句「名字也没出现」。这里把名片补上。
const MEMBER_CACHE = new Map();
const MEMBER_TTL = 10 * 60_000;

async function memberNames(cfg, gid) {
  const key = String(gid || "");
  if (!key) return new Map();
  const hit = MEMBER_CACHE.get(key);
  if (hit && Date.now() - hit.at < MEMBER_TTL) return hit.map;

  const map = new Map();
  const r = await groupMemberList(cfg, key);
  if (r.ok && Array.isArray(r.data)) {
    for (const m of r.data) {
      const id = String(m.user_id ?? m.uin ?? "");
      if (id) map.set(id, String(m.card || m.nickname || id).trim());
    }
  }
  MEMBER_CACHE.set(key, { at: Date.now(), map });
  if (MEMBER_CACHE.size > 60) MEMBER_CACHE.delete(MEMBER_CACHE.keys().next().value);
  return map;
}

// 这条群消息有没有 @ 我。array 格式看 segments，string 格式退回翻 CQ 码。
export function atTarget(ev, qq) {
  const id = String(qq || "");
  if (!id) return false;
  const segs = Array.isArray(ev?.message) ? ev.message : [];
  for (const s of segs) {
    if (s?.type !== "at") continue;
    const to = String(s?.data?.qq ?? s?.data?.user_id ?? "");
    if (to === id) return true;
  }
  const raw = String(ev?.raw_message || "");
  return new RegExp(`\\[CQ:at,qq=${id}(?:,|\\])`).test(raw);
}

// 拉私聊历史。服务没在线时 NapCat 的上报会直接 ECONNREFUSED 丢掉，
// 唯一补回来的办法就是起来之后主动往回翻。
export function friendHistory(cfg, userId, count = 50) {
  if (!userId) return Promise.resolve({ ok: false, skipped: true, error: "还没填你的 QQ 号" });
  return call(cfg, "get_friend_msg_history", {
    user_id: Number(userId),
    count: Math.min(Math.max(Number(count) || 50, 1), 100)
  }, 12000);
}

export function loginInfo(cfg) {
  return call(cfg, "get_login_info", {}, 8000);
}

export async function probe(cfg) {
  const r = await loginInfo(cfg);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  const same = cfg.bot && String(d.user_id) && String(d.user_id) !== cfg.bot;
  return {
    ok: true,
    user_id: String(d.user_id || ""),
    nickname: d.nickname || "",
    warning: same ? `NapCat 登录的是 ${d.user_id}，和配置里的 ${cfg.bot} 不一致` : ""
  };
}

// ---- 消息解析 ----

const CQ_ESC = { "&#91;": "[", "&#93;": "]", "&#44;": ",", "&amp;": "&" };
const unCQ = s => String(s).replace(/&#91;|&#93;|&#44;|&amp;/g, m => CQ_ESC[m]);

// NapCat 可配「消息格式 = 字符串」，那就得自己拆 CQ 码。
// 两种格式都吃，免得配置项一错整个识别就瘫。
function cqToSegments(str) {
  const out = [];
  const re = /\[CQ:([a-z_.]+)((?:,[^\]]*)?)\]/gi;
  let last = 0;
  let m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ type: "text", data: { text: str.slice(last, m.index) } });
    const data = {};
    for (const kv of String(m[2] || "").split(",")) {
      if (!kv) continue;
      const i = kv.indexOf("=");
      if (i > 0) data[kv.slice(0, i)] = unCQ(kv.slice(i + 1));
    }
    out.push({ type: m[1].toLowerCase(), data });
    last = re.lastIndex;
  }
  if (last < str.length) out.push({ type: "text", data: { text: str.slice(last) } });
  return out;
}

export function segmentsOf(message) {
  if (Array.isArray(message)) return message;
  if (typeof message === "string") return cqToSegments(message);
  return [];
}

// 递归展开合并转发，把一条「多选转发」还原成整段文本 + 图
export async function readMessage(cfg, message, depth = 0, opts = {}) {
  const segments = segmentsOf(message);
  const texts = [];
  const images = [];

  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    if (seg.type === "text") {
      texts.push(String(seg.data?.text ?? ""));
    } else if (seg.type === "at") {
      // @ 谁必须留下：群里靠这个才知道「这个」指的是哪个人。
      const qq = String(seg.data?.qq ?? seg.data?.user_id ?? "");
      if (!qq) continue;
      if (qq === "all") { texts.push("@全体成员 "); continue; }
      let name = String(seg.data?.name || seg.data?.card || "").trim();
      if (!name && opts.gid) {
        const map = await memberNames(cfg, opts.gid);
        name = map.get(qq) || "";
      }
      texts.push(`@${name || qq} `);
    } else if (seg.type === "image") {
      const url = seg.data?.url || seg.data?.file || "";
      if (url && /^https?:|\.(png|jpe?g|gif|webp|bmp)$/i.test(url)) images.push(url);
    } else if (seg.type === "forward" && depth < 2) {
      const id = seg.data?.id;
      if (!id) continue;
      const r = await getForward(cfg, id);
      const nodes = r.data?.messages || r.data?.message || [];
      if (!Array.isArray(nodes) || !nodes.length) {
        texts.push("");
        continue;
      }
      const parts = [];
      for (const node of nodes) {
        const inner = await readMessage(cfg, node.message ?? node.content ?? node.data?.content, depth + 1, opts);
        const nick = node.sender?.card || node.sender?.nickname || node.nickname || "";
        const line = inner.text.trim();
        if (line) parts.push(nick ? `${nick}：${line}` : line);
        images.push(...inner.images);
      }
      if (parts.length) texts.push(parts.join("\n"));
    }
  }

  return { text: texts.join("").trim(), images };
}

function getForward(cfg, id) {
  return call(cfg, "get_forward_msg", { message_id: id, id });
}

export async function fetchImage(url) {
  if (/^https?:/i.test(url)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `图片下载失败 HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      return { ok: true, buf, mime };
    } catch (err) {
      return { ok: false, error: err.name === "AbortError" ? "图片下载超时" : err.message };
    } finally {
      clearTimeout(timer);
    }
  }
  // NapCat 和我们在同一台机器时可能直接给本地路径
  try {
    const p = url.replace(/^file:\/\/\/?/i, "");
    return { ok: true, buf: await readFile(p), mime: "image/png" };
  } catch (err) {
    return { ok: false, error: `读不到图片：${err.message}` };
  }
}
