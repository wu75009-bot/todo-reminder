// 腾讯云函数 SCF：云端守时器
// 部署由电脑上的 cloud/deploy.mjs 完成，不用手工在控制台建。
//
// 工作方式：
//   本地电脑开机、或任务有变动时，会把未来 7 天的提醒整份写进下面这行 QUEUE，
//   然后调 UpdateFunctionCode 把整个文件传上来。之后电脑关不关都不影响。
//   定时触发器每分钟调一次，函数自己算“这 60 秒内该响哪几条”。
//
// 为什么不用“已发送”标记：函数是无状态的，写不了自己的状态。
// 改成年份窗口判定——只在 [at, at+55s] 这个区间里发，而触发器 60 秒才来一次，
// 所以每条提醒天然只会命中一次，不需要任何存储。

const QUEUE = /*__QUEUE__*/ [];

const WINDOW_MS = 55 * 1000;

function spt(env) {
  return String(env.WXPUSHER_SPT || "").trim();
}

async function push(env, item) {
  const key = spt(env);
  if (!key) return { ok: false, error: "没有配置 WXPUSHER_SPT" };
  const text = `${item.title || "待办提醒"}\n${item.body || ""}`.slice(0, 500);
  const url = `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(key)}/${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => null);
    return { ok: Boolean(j && j.code === 1000), detail: j };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 手工触发：控制台“测试运行”给的是 event，Invoke 接口给的是 context.clientContext
function isManual(event, context) {
  if (event && (event.test || event.manual)) return true;
  const c = context && context.clientContext;
  if (typeof c === "string") {
    try { const j = JSON.parse(c); return Boolean(j && (j.test || j.manual)); } catch { return false; }
  }
  return false;
}

exports.main_handler = async (event, context) => {
  const env = process.env;
  const now = Date.now();

  // 手工触发时直接发一条确认活着
  const manual = isManual(event, context);
  if (manual) {
    const r = await push(env, {
      title: "云端守时器在线",
      body: `队列里有 ${QUEUE.length} 条，服务器时间 ${new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")}（北京时间）`
    });
    return { ok: r.ok, manual: true, queued: QUEUE.length, detail: r };
  }

  const due = [];
  for (const it of QUEUE) {
    const at = Number(it && it.at);
    if (!Number.isFinite(at)) continue;
    const late = now - at;
    if (late >= 0 && late <= WINDOW_MS) due.push(it);
  }

  const results = [];
  for (const it of due) {
    const r = await push(env, it);
    results.push({ id: it.id, title: it.title, ok: r.ok, error: r.error });
  }

  if (results.length) console.log("发出提醒", JSON.stringify(results));
  return { ok: true, fired: results.filter(r => r.ok).length, due: due.length, queued: QUEUE.length, results };
};
