// 云端守时器：把"到点该提醒"这件事从你的电脑上搬走。
// 电脑开着时会把未来几天的提醒整份同步上来；电脑关了，这里每分钟检查一次，
// 到点就调 PushPlus 发到你微信。这样关机、断网都不影响。
//
// 部署：Cloudflare Workers 免费版即可。
//  1. 新建 Worker，把本文件内容粘进去
//  2. Settings → Variables：
//       WXPUSHER_SPT   你的 SPT_ 开头那串（加密保存）
//       SYNC_KEY       自定义一串口令，本地服务同步时要用
//  3. Storage → KV → 新建命名空间，绑定变量名填 TODO
//  4. Settings → Triggers → Cron 填 * * * * *
//
// 接口：
//   POST /sync   { token, items: [{id, at, title, body}] }  整份覆盖待发队列
//   GET  /ping   看看还活着没、队列里还有多少条

const QUEUE_KEY = "queue";
const SENT_KEY = "sent-ids";
const MAX_SENT = 800;
// 迟到超过这么久就不再补发：半夜三点的"该交作业了"没有意义，只会把人吵醒
const LATE_WINDOW_MS = 6 * 3600 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

async function readSent(env) {
  const raw = await env.TODO.get(SENT_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function writeSent(env, ids) {
  await env.TODO.put(SENT_KEY, JSON.stringify(ids.slice(-MAX_SENT)));
}

async function pushWechat(env, item) {
  const spt = String(env.WXPUSHER_SPT || "").trim();
  if (!spt) return { ok: false, error: "没有配置 WXPUSHER_SPT" };
  // 极简推送接口：SPT + 正文都放在路径里，GET 即可
  const text = `${item.title || "待办提醒"}\n${item.body || ""}`.slice(0, 500);
  const res = await fetch(
    `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(spt)}/${encodeURIComponent(text)}`,
    { method: "GET" }
  );
  let j = null;
  try { j = await res.json(); } catch {}
  const ok = res.ok && j && j.code === 1000;
  return { ok, code: j && j.code, msg: j && j.msg };
}

async function tick(env) {
  const raw = await env.TODO.get(QUEUE_KEY);
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  if (!list.length) return { fired: 0, pending: 0 };

  const sent = new Set(await readSent(env));
  const now = Date.now();
  let fired = 0;
  const keep = [];

  for (const it of list) {
    const at = Number(it.at);
    if (!Number.isFinite(at)) continue;
    if (sent.has(it.id)) continue;

    if (at > now) { keep.push(it); continue; }
    if (now - at > LATE_WINDOW_MS) { sent.add(it.id); continue; }

    const r = await pushWechat(env, it);
    if (r.ok) {
      sent.add(it.id);
      fired++;
    } else {
      // 发失败了就留着下一分钟再试，但别无限重试：超过窗口就当过期
      keep.push(it);
    }
  }

  await writeSent(env, [...sent]);
  await env.TODO.put(QUEUE_KEY, JSON.stringify(keep));
  return { fired, pending: keep.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      const raw = await env.TODO.get(QUEUE_KEY);
      let n = 0;
      try { n = raw ? JSON.parse(raw).length : 0; } catch {}
      return json({
        ok: true,
        queued: n,
        hasToken: Boolean(env.WXPUSHER_SPT),
        hasKey: Boolean(env.SYNC_KEY),
        serverTime: new Date().toISOString()
      });
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { return json({ ok: false, error: "body 不是 JSON" }, 400); }
      if (env.SYNC_KEY && body.token !== env.SYNC_KEY) {
        return json({ ok: false, error: "口令不对" }, 401);
      }
      const items = Array.isArray(body.items) ? body.items : [];
      const clean = items
        .filter(x => x && x.id && Number.isFinite(Number(x.at)))
        .map(x => ({
          id: String(x.id),
          at: Number(x.at),
          title: String(x.title || "待办提醒").slice(0, 120),
          body: String(x.body || "").slice(0, 500)
        }));

      const sent = new Set(await readSent(env));
      const pending = clean.filter(x => !sent.has(x.id));
      await env.TODO.put(QUEUE_KEY, JSON.stringify(pending));
      return json({ ok: true, received: clean.length, queued: pending.length, skipped: clean.length - pending.length });
    }

    if (url.pathname === "/tick") {
      // 手动触发一次，方便部署后立刻验证
      if (env.SYNC_KEY && url.searchParams.get("token") !== env.SYNC_KEY) {
        return json({ ok: false, error: "口令不对" }, 401);
      }
      return json({ ok: true, ...(await tick(env)) });
    }

    return json({ ok: false, error: "没有这个接口" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  }
};
