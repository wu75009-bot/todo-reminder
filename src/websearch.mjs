// 让它能上网查。
//
// 为什么需要这一层：模型本身只会「背」，村里的地名、某学校几点放学、某产品参数、
// 上周的新闻，这些都在它训练数据之外。不给它搜索，它只有两条路——编，或者说不知道，
// 用户看到的就是「笨」。差别不在模型，在有没有工具。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "user-agent": UA,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

function decode(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;|&emsp;|&thinsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

// bing 有些结果是跳转链接（/ck/a?...&u=a1<base64>），把真地址抠出来
function realUrl(href) {
  const h = String(href || "");
  if (!h) return "";
  if (!/bing\.com\/ck\/a/i.test(h)) return h;
  const m = /[?&]u=a1([^&]+)/.exec(h);
  if (!m) return h;
  try {
    const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const s = Buffer.from(b, "base64").toString("utf8");
    return /^https?:\/\//.test(s) ? s : h;
  } catch {
    return h;
  }
}

// ---- 各引擎的解析：都只提取「标题 + 链接 + 摘要」三样 ----
//
// 实测（2026-11-04）：同一条很偏的长尾地名查询，
//   360  → 村委会简介、地图、村级资料，全中；
//   百度 → 也全中，但页面近 1MB，慢；
//   bing → 只返回上级行政区百科、乃至无关站点，长尾词基本废掉，所以只当最后兜底。

function parseSo360(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="res-list[\s\S]*?<\/li>/g)) {
    const b = m[0];
    const h3 = (b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || "";
    const title = decode(h3);
    // href 是 so.com 的跳转，真地址在 data-mdurl 上
    const url = decode((b.match(/data-mdurl="([^"]+)"/) || [])[1] || "") || realUrl((b.match(/href="([^"]+)"/) || [])[1]);
    const snippet = decode(
      (b.match(/data-result-summary[^>]*>([\s\S]*?)<\/span>/) || [])[1] ||
      (b.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ""
    );
    if (title && url && /^https?:/.test(url)) out.push({ title, url, snippet: snippet.slice(0, 300) });
  }
  return out;
}

function parseBaidu(html) {
  const out = [];
  for (const m of html.matchAll(/<div[^>]+class="result[^"]*c-container[\s\S]*?(?=<div[^>]+class="result[^"]*c-container|$)/g)) {
    const b = m[0];
    const h3 = (b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || "";
    const title = decode(h3);
    // mu 属性是真地址；没有就退回 href（通常是 baidu.com/link?url= 跳转）
    const url = decode((b.match(/\bmu="([^"]+)"/) || [])[1] || (b.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || "");
    const body = decode(b.replace(h3, " "));
    if (title && url && /^https?:/.test(url)) out.push({ title, url, snippet: body.slice(0, 300) });
  }
  return out;
}

function parseBing(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const b = m[0];
    const title = decode((b.match(/<h2[^>]*>[\s\S]*?<\/h2>/) || [""])[0]);
    const href = realUrl((b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"/) || [])[1]);
    const snippet = decode(
      (b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] ||
      (b.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ""
    );
    if (title && href) out.push({ title, url: href, snippet: snippet.slice(0, 300) });
  }
  return out;
}

const ENGINES = [
  {
    name: "360",
    url: q => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
    parse: parseSo360
  },
  {
    name: "百度",
    url: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&ie=utf-8`,
    parse: parseBaidu
  },
  {
    name: "bing",
    url: q => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=10`,
    parse: parseBing
  }
];

// ---- 首选：DeepSeek 官方 Search / Fetch API ----
//
// 2026-11-05 才接上的。它是官方自带的内网搜索引擎，不是抓别人的结果页：
// 一次请求 0.4 秒返回，每条都带 summary（600-800 字的成段摘要）、发布时间、权威度，
// 比我们自己去解析 360/百度 的 HTML 稳得多 —— 那种做法对方一改版就全废。
//
// 计费按次，$0.75 / 1000 次（约 5 厘一次），搜索失败或没结果不收费。
// 拿不到 key 的时候自动退回下面的抓取引擎，功能不会因此消失。
const DS_BASE = "https://api.deepseek.com";

function dsHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

async function dsSearch(q, { apiKey, count, timeoutMs }) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${DS_BASE}/v1/tools/search`, {
      method: "POST",
      headers: dsHeaders(apiKey),
      body: JSON.stringify({ query: q.slice(0, 128), count: Math.min(20, Math.max(1, count)), need_content: false }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const list = (j?.results || [])
      .filter(x => x?.title && x?.url)
      .map(x => ({
        title: String(x.title),
        url: String(x.url),
        // summary 是成段的，比 snippet 那一百来字有用得多，模型能直接据此回答
        snippet: String(x.summary || x.snippet || "").slice(0, 900),
        date: x.date ? String(x.date).slice(0, 10) : "",
        authority: Number.isFinite(x.authority) ? x.authority : null
      }));
    return list.length ? list : null;
  } catch {
    return null;
  }
}

const cache = new Map();
const CACHE_TTL = 10 * 60_000;

export async function webSearch(query, { count = 5, timeoutMs = 12000, apiKey = "" } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "搜索词是空的" };

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.value, cached: true };

  // 先用官方接口。它失败（没 key、欠费、限流、超时）就当没发生，继续走抓取。
  const official = await dsSearch(q, { apiKey, count, timeoutMs: Math.min(timeoutMs, 20000) });
  if (official) {
    const value = { ok: true, engine: "官方", query: q, results: official };
    cache.set(q, { at: Date.now(), value });
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return value;
  }

  const errors = [];
  for (const eng of ENGINES) {
    try {
      const res = await fetch(eng.url(q), { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { errors.push(`${eng.name} ${res.status}`); continue; }
      const html = await res.text();
      const list = eng.parse(html).filter(r => r.title && r.url).slice(0, count);
      if (!list.length) { errors.push(`${eng.name} 没解析出结果`); continue; }
      const value = { ok: true, engine: eng.name, query: q, results: list };
      cache.set(q, { at: Date.now(), value });
      if (cache.size > 80) cache.delete(cache.keys().next().value);
      return value;
    } catch (err) {
      errors.push(`${eng.name} ${err.name === "TimeoutError" ? "超时" : err.message.slice(0, 40)}`);
    }
  }
  return { ok: false, error: `搜索失败：${errors.join("；")}` };
}

// 打开网页读正文。搜索结果只有一两行摘要，问细节时不够用，要真的把页面读下来。
export async function fetchPage(url, { maxChars = 3500, timeoutMs = 12000, apiKey = "" } = {}) {
  let u;
  try { u = new URL(String(url || "")); } catch { return { ok: false, error: "网址看不懂" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "只支持 http/https 网址" };

  // 官方 Fetch 直接给干净的 Markdown 正文，省掉我们自己的去标签和掐头去尾。
  if (apiKey) {
    try {
      const res = await fetch(`${DS_BASE}/v1/tools/fetch`, {
        method: "POST",
        headers: dsHeaders(apiKey),
        body: JSON.stringify({ url: u.toString() }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 20000))
      });
      if (res.ok) {
        const j = await res.json();
        const text = String(j?.content || "");
        if (text.trim().length > 80) {
          return {
            ok: true,
            url: u.toString(),
            title: String(j.title || "").slice(0, 120),
            text: text.slice(0, maxChars),
            truncated: text.length > maxChars,
            via: "官方"
          };
        }
      }
    } catch { /* 落到下面自己抓 */ }
  }

  try {
    const res = await fetch(u.toString(), {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, error: `网页返回 ${res.status}` };

    const ct = String(res.headers.get("content-type") || "");
    if (!/text\/html|text\/plain|application\/json/i.test(ct)) {
      return { ok: false, error: `这个链接不是网页（${ct || "未知类型"}）` };
    }

    const raw = await res.text();
    let text = decode(raw);

    // 正文通常在中段，导航栏和页脚是噪音：掐头去尾留中间，再截断
    if (text.length > maxChars * 3) {
      const mid = text.slice(Math.floor(text.length * 0.1), Math.floor(text.length * 0.9));
      text = mid;
    }

    return {
      ok: true,
      url: u.toString(),
      title: decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars
    };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "网页加载超时" : `打不开：${err.message.slice(0, 60)}` };
  }
}

// 给模型看的紧凑文本：比让模型读 JSON 省 token，也更不容易读串行
export function searchToText(r) {
  if (!r?.ok) return r?.error || "搜索没结果";
  const lines = r.results.map((x, i) => {
    const when = x.date ? `（发布于 ${x.date}）` : "";
    return `${i + 1}. ${x.title}${when}\n${x.url}\n${x.snippet || ""}`.trim();
  });
  return `搜索「${r.query}」（${r.engine}）：\n\n${lines.join("\n\n")}`;
}
