// 云端模型兜底：规则看不懂的通知，交给 DeepSeek V4.1-Flash 看一眼。
//
// 这个模块的职责边界很窄：模型只负责「看懂字面写的是什么」，不负责「决定提醒策略」。
// 因此它给出的每一个时间点，都必须能指回原文的某个片段（evidence），
// 指不回去的一律作废。宁可缺一条提醒，也不要在一个错的日期上准时叫你。

const DEFAULT_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";

// 美元/百万 token，取 DeepSeek 峰值价（闲时是半价，所以这是保守估计）
const PRICE = { inMiss: 0.30, out: 1.20 };
const USD_CNY = 7.1;

export function llmConfig(raw = {}) {
  const e = raw || {};
  const apiKey = e.apiKey || process.env.DEEPSEEK_API_KEY || "";
  return {
    // 显式关掉就是关掉；没显式关、又有 key，就算启用
    enabled: e.enabled === false ? false : Boolean(apiKey),
    baseUrl: String(e.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ""),
    model: String(e.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL),
    apiKey,
    // fallback：只在规则没把握时才调（省钱）
    // always：每次都调（准，但每次都花钱）
    mode: e.mode === "always" ? "always" : "fallback",
    // model：图片直接给模型看（小字、表格、卡片式通知都更准）
    // ocr：先用系统 OCR 转文字，再交给模型（更省，但会丢字）
    imageMode: e.imageMode === "ocr" ? "ocr" : "model",
    // 思考深度：low / high / max。默认 high —— 群里聊天 high 已经够用，
    // max 只多花 token 和几百毫秒，回答质量的提升肉眼看不出来。
    //
    // 注意字段名：接口认的是 reasoning_effort（值 none/low/high/max）。
    // 曾经写成 effort，接口不报错、直接忽略，于是「调成 max」一直没生效，实际跑的一直是默认 high。
    // 配置项仍叫 effort，只是在发请求时映射成 reasoning_effort。
    effort: ["low", "high", "max", "none"].includes(e.effort) ? e.effort : "high",
    // 思考模式里 reasoning 和正文共用 max_tokens。给 1400 时，遇到要展开答的问题会被从中间截断
    // （finish_reason=length），表现出来就是「话说到一半没了」。调大不影响费用，只按实际生成的算。
    maxTokens: Number(e.maxTokens) > 0 ? Number(e.maxTokens) : 3000,
    timeoutMs: Number(e.timeoutMs) > 0 ? Number(e.timeoutMs) : 30000
  };
}

export function llmReady(cfg) {
  return Boolean(cfg && cfg.enabled && cfg.apiKey);
}

export function publicLlmConfig(cfg) {
  if (!cfg) return null;
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    mode: cfg.mode,
    imageMode: cfg.imageMode,
    hasKey: Boolean(cfg.apiKey),
    keyHint: cfg.apiKey ? cfg.apiKey.slice(0, 3) + "…" + cfg.apiKey.slice(-4) : ""
  };
}

const pad = n => String(n).padStart(2, "0");

function todayLine(nowMs) {
  const f = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false
  });
  const d = new Date(nowMs);
  const p = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  return `${p.year}年${p.month}月${p.day}日 ${p.weekday} ${p.hour}:${p.minute}`;
}

// 注意：这个函数只能返回「永远不变」的内容。
// 日期、时间这些每天都变的东西必须放到用户消息里 —— 否则前缀一变，
// DeepSeek 的上下文缓存就命中不了，每条通知都要按全价付 system prompt 的钱。
function systemPrompt(rules) {
  const types = rules
    .filter(r => !r.isDefault)
    .map(r => `- ${r.name}（常用词：${(r.match || []).slice(0, 8).join("、") || "无"}）`)
    .join("\n");
  const fallbackName = rules.find(r => r.isDefault)?.name || "其他";

  return `你是一个通知解析器。把用户给的一条通知（文字或图片）解析成一条待办事项，只输出一个 JSON 对象。

可选的任务类型 type：
${types || "- 其他"}
- ${fallbackName}（都不匹配时用这个）

输出 JSON 的字段（严格按此结构）：
{
  "type": "上面列表里的某一个类型名",
  "title": "简短标题，20 字以内，去掉群名和寒暄",
  "course": "课程名，没有就 null",
  "start": "开始时间，ISO 格式 2026-11-10T14:00:00+08:00，没有就 null",
  "end": "结束时间，同上，没有就 null",
  "due": "截止时间，同上，没有就 null",
  "location": "地点，没有就 null",
  "confidence": 0 到 1 之间的数字，表示你对这条解析的把握,
  "rawText": "你在图片里看到的完整文字，逐行保留；如果输入是文字，原样返回输入内容",
  "evidence": {
    "start": "原文中支持 start 这个时间的片段，逐字复制",
    "end": "同上",
    "due": "同上"
  },
  "notes": ["任何你不确定、或者需要人核对的点"]
}

硬性规则，违反任何一条这条结果就不可用：
1. 原文没有写的时间，对应字段必须是 null。绝对不许根据常识推测、补全、或者「贴心地」给一个看起来合理的日期。
2. evidence 里的每一段必须是 rawText 中真实出现的原文片段，逐字复制，不要改写、不要概括。你指不出原文出处的时间，就把那个字段填 null。
3. 只写了日期没写时刻的，时刻按 09:00 填，并在 notes 里写明「原文未给具体时刻，按 09:00 处理」。
4. 如果写的是一个时间段（如「19:00 至 21:00」「14:00-15:40」），拆成 start 和 end 两个字段。
5. 语义映射：「截止 / 之前 / 前提交 / DDL」→ due；「开始 / 开考 / 上课」→ start；「结束 / 收卷 / 散会」→ end。
6. 如果整条通知完全没有任何时间信息，start、end、due 三个字段全部填 null，notes 里写「通知里没有时间信息」。不要猜。
7. 遇到 OCR 或截图里的错别字，按上下文纠正成正确的词（比如「考讠」→「考试」），但 rawText 里保留你看到的原样。
8. 只输出 JSON 本身，不要 markdown 代码块，不要任何解释性文字。`;
}

// ---------- 校验：把模型的「自信」按原文核对 ----------

const norm = s => String(s || "")
  .replace(/[\s\u3000]/g, "")
  .replace(/[：:，,。.、；;（）()【】\[\]「」『』"'“”‘’|—–\-~～]/g, "");

// evidence 是否真的出自原文。
// 先严格比对；不中再退一步：只要其中的数字/相对时间词都能在原文里找到，也算过关。
// 这个退让是为了容忍模型把「11月10日 23:59」写成「11月10日23:59」之外的轻微改写。
function evidenceOk(ev, src) {
  const e = norm(ev);
  if (e.length < 2) return false;
  if (src.includes(e)) return true;

  const nums = e.match(/\d{1,4}/g);
  if (nums && nums.length && nums.every(n => src.includes(n))) return true;

  const rel = e.match(/今天|今日|明天|明日|后天|大后天|下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|下个?月|月底|月初|今晚|明早|今天下午/g);
  if (rel && rel.length && rel.every(w => src.includes(norm(w)))) return true;

  return false;
}

// 对模型结果做一遍核对，返回 { value, notes, dropped }
export function verify(result, { source = "", nowMs = Date.now() } = {}) {
  const src = norm(source);
  const notes = [];
  const dropped = [];
  const value = { start: null, end: null, due: null };

  for (const key of ["start", "end", "due"]) {
    const iso = result?.[key];
    if (!iso) continue;

    const label = { start: "开始", end: "结束", due: "截止" }[key];
    const ev = result?.evidence?.[key];

    if (!ev) {
      dropped.push({ key, reason: `模型没有给出「${label}」的原文依据` });
      continue;
    }
    if (src && !evidenceOk(ev, src)) {
      dropped.push({ key, reason: `模型说「${label}」是 ${iso.slice(0, 16)}，但依据「${String(ev).slice(0, 30)}」在原文里找不到，已作废` });
      continue;
    }

    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
      dropped.push({ key, reason: `模型给的「${label}」时间格式读不懂：${iso}` });
      continue;
    }
    if (t < nowMs - 40 * 86400_000) {
      notes.push(`模型给的${label}时间在 ${iso.slice(0, 10)}，已经过去一个多月了，请确认是不是原文里的旧日期`);
    }
    if (t > nowMs + 400 * 86400_000) {
      dropped.push({ key, reason: `模型给的${label}时间超过一年，明显不合理，已作废` });
      continue;
    }

    value[key] = iso;
  }

  // 开始晚于结束：几乎一定是模型把两者弄反了，换回来并在界面上说明
  if (value.start && value.end && Date.parse(value.start) > Date.parse(value.end)) {
    const a = value.start;
    value.start = value.end;
    value.end = a;
    notes.push("模型把开始和结束时间写反了，已自动对调，请核对");
  }

  return { value, notes, dropped };
}

// ---------- 与 DeepSeek 通信 ----------

const cache = new Map();
const CACHE_MAX = 60;
const CACHE_TTL = 30 * 60_000;

function cacheKey(cfg, text, image) {
  // 带上 baseUrl：换了服务端（比如从自建/代理切回官方）就不该复用旧结果
  return `${cfg.baseUrl}\u0000${cfg.model}\u0000${text.length}\u0000${text.slice(0, 600)}\u0000${image ? image.length : 0}\u0000${image ? image.slice(0, 120) : ""}`;
}

function costCNY(usage) {
  if (!usage) return 0;
  const inTok = Number(usage.prompt_tokens || 0);
  const cached = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Math.max(0, inTok - cached);
  const out = Number(usage.completion_tokens || 0);
  const usd = (miss / 1e6) * PRICE.inMiss + (cached / 1e6) * 0.006 + (out / 1e6) * PRICE.out;
  return Math.round(usd * USD_CNY * 10000) / 10000;
}

export async function llmParse({ text = "", image = null, mime = "image/png", config, rules = [], nowMs = Date.now() }) {
  const cfg = llmConfig(config);
  if (!llmReady(cfg)) return { ok: false, code: "not-configured", error: "没有配置 API Key" };

  const key = cacheKey(cfg, text, image);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ...hit.value, cached: true };
  }

  // 日期放在用户消息里，system prompt 保持完全静态 —— 这样上下文缓存才命中得了
  const stamp = `现在是 ${todayLine(nowMs)}（Asia/Shanghai，UTC+8）。`;
  const ask = image ? "请解析这张图片里的通知。" : `通知内容：\n${text}`;

  const userContent = image
    ? [
        { type: "image_url", image_url: { url: `data:${mime};base64,${image}`, detail: "high" } },
        { type: "text", text: `${stamp}\n${ask}` }
      ]
    : `${stamp}\n${ask}`;

  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt(rules) },
      { role: "user", content: userContent }
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 1600,
    stream: false
  };

  const started = Date.now();
  let res, raw;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      code: timeout ? "timeout" : "network",
      error: timeout ? `模型 ${cfg.timeoutMs / 1000} 秒没返回，已放弃（规则的结果仍然可用）` : `连不上 ${cfg.baseUrl}：${err.message}`
    };
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const map = {
      401: "API Key 不对或已失效，去 platform.deepseek.com 重新生成一个",
      402: "账户余额不足，去 platform.deepseek.com 充值",
      429: "请求太频繁，被限流了，过一会儿再试",
      500: "模型服务端出错了，稍后再试",
      503: "模型服务暂时不可用，稍后再试"
    };
    return {
      ok: false,
      code: `http-${res.status}`,
      error: map[res.status] || `模型接口返回 ${res.status}：${detail}`
    };
  }

  const elapsed = Date.now() - started;

  try {
    raw = await res.json();
  } catch {
    return { ok: false, code: "bad-json", error: "模型返回的不是 JSON" };
  }

  const textOut = raw?.choices?.[0]?.message?.content;
  if (!textOut) {
    return { ok: false, code: "empty", error: "模型没有返回内容（可能被内容审核拦了）", usage: raw?.usage };
  }

  let parsed;
  try {
    // 偶尔会裹一层 ```json，剥掉
    parsed = JSON.parse(String(textOut).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch {
    return { ok: false, code: "bad-json", error: "模型返回的内容不是合法 JSON", detail: String(textOut).slice(0, 300), usage: raw?.usage };
  }

  // 校验用的「原文」：图片只能用模型自己读出来的字，文字则用用户给的原文
  const source = image ? String(parsed.rawText || "") : text;
  const checked = verify(parsed, { source, nowMs });

  const usage = raw?.usage || null;
  const value = {
    ok: true,
    parsed,
    value: checked.value,
    notes: checked.notes,
    dropped: checked.dropped,
    source,
    usage: usage ? {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_cache_hit_tokens ?? 0,
      costCNY: costCNY(usage)
    } : null,
    latencyMs: elapsed,
    model: cfg.model
  };

  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return value;
}

// ---------- 看图说话 ----------
// llmParse 的活是「把图片当通知解析成待办」，图上没通知它就答「不是通知」——
// 群里聊天时这条没用：别人发自拍、发表情包、发截图，都需要它「看见」。
// 这个函数只干一件事：如实描述图里有什么，顺便把图上的字抄下来。
const DESCRIBE_SYSTEM = `你在一个 QQ 群里聊天。有人发了一张图，你要用中文如实说出你看到了什么。

要求：
- 一句话到三句话，口语，像在群里跟人说「这不就是个……」
- 是照片就说拍了什么；是截图就说是什么界面的截图、写的什么；是表情包就说它是什么梗、什么情绪
- 图里有文字就原样抄下来（通知、公告、课程表、聊天记录都算），抄清楚，别改写
- 不要评价、不要客套、不要解释你在干什么，直接说图和字
- 实在看不清就说看不清，别编`;

const describeCache = new Map();

// 同一张图别反复花钱：按内容哈希缓存 10 分钟。
export async function llmDescribeImage({ image, mime = "image/png", config, hint = "" }) {
  const cfg = llmConfig(config);
  if (!llmReady(cfg)) return { ok: false, code: "not-configured", error: "没有配置 API Key" };

  const key = cacheKey(cfg, `describe\u0000${hint}`, image);
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return { ...hit.value, cached: true };

  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: DESCRIBE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${image}`, detail: "high" } },
          { type: "text", text: hint ? `群里刚发的，紧跟着这句：${hint}` : "群里刚发的这张图。" }
        ]
      }
    ],
    temperature: 0.3,
    max_tokens: 500,
    stream: false
  };

  const started = Date.now();
  let res, raw;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      code: timeout ? "timeout" : "network",
      error: timeout ? `看图超时（${cfg.timeoutMs / 1000} 秒）` : `连不上 ${cfg.baseUrl}：${err.message}`
    };
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return { ok: false, code: `http-${res.status}`, error: `看图接口返回 ${res.status}：${detail}` };
  }

  try { raw = await res.json(); } catch { return { ok: false, code: "bad-json", error: "看图返回的不是 JSON" }; }

  const text = String(raw?.choices?.[0]?.message?.content || "").trim();
  if (!text) return { ok: false, code: "empty", error: "模型没说出图上有什么" };

  const value = {
    ok: true,
    text: text.slice(0, 800),
    usage: raw?.usage ? {
      inputTokens: raw.usage.prompt_tokens ?? 0,
      outputTokens: raw.usage.completion_tokens ?? 0,
      cachedTokens: raw.usage.prompt_cache_hit_tokens ?? 0,
      costCNY: costCNY(raw.usage)
    } : null,
    latencyMs: Date.now() - started,
    model: cfg.model
  };
  describeCache.set(key, { at: Date.now(), value });
  if (describeCache.size > 100) describeCache.delete(describeCache.keys().next().value);
  return value;
}

// ---------- 意图判断 ----------
// 规则只认「字面」，认不出「这句话是想取消，还是想新建」。
// 这一层专门问模型：这条消息到底想干什么。输出极简，一次几厘钱。

const INTENT_SYSTEM = `你是 QQ 待办助手的意图判断器。用户在 QQ 上给机器人小号发消息，你判断这条消息想干什么。

只输出一个 JSON 对象：
{
  "intent": "new_task" | "cancel_task" | "complete_task" | "supplement_time" | "query" | "chat",
  "target": "要处理的那条待办标题，必须从给定待办列表里原样选取；对不上就填空字符串",
  "time": "只有 supplement_time 才填，格式 2026-11-05T14:30:00+08:00；其他情况填空字符串",
  "reply": "intent 是 chat 或 query 时给一句不超过 40 字的中文回复；其他情况填空字符串",
  "confidence": 0.0 到 1.0 之间的数
}

各意图含义：
- new_task：一条新的待办或通知，包含要做的事，通常带时间
- cancel_task：撤掉已经记下的某条待办（例：「讲座取消了」「物理小测不去了」「那个不用了」）
- complete_task：某条已经做完了（例：「作业交了」「考试考完了」）
- supplement_time：机器人刚追问过时间，用户在补充（例：机器人问「几点」→ 用户回「明天下午3点」）
- query：问手上有哪些待办
- chat：闲聊、语气词、判断不了的碎片

关键判断：
- 「XX取消了」默认是 cancel_task，绝不要当成 new_task
- 只有「明天的」「后天」这类没有具体时刻的短碎片，才考虑 supplement_time；没有上下文时按 chat
- 不要为了凑一条待办而硬判 new_task`;

export async function llmIntent({ text = "", tasks = [], pending = null, config, nowMs = Date.now() }) {
  const cfg = llmConfig(config);
  if (!llmReady(cfg)) return { ok: false, code: "not-configured", error: "没有配置 API Key" };

  const list = tasks.length
    ? tasks.slice(0, 20).map(t => {
        const when = t.start || t.due || t.end || "";
        return `- ${t.title}${when ? "｜" + when : "｜还没时间"}`;
      }).join("\n")
    : "（当前没有待办）";

  const user = [
    `现在是 ${todayLine(nowMs)}（Asia/Shanghai，UTC+8）。`,
    "",
    "当前待办：",
    list,
    "",
    pending ? `机器人在等这条补时间：${pending}` : "（没有在等补时间的待办）",
    "",
    "用户消息：",
    text
  ].join("\n");

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: INTENT_SYSTEM },
          { role: "user", content: user }
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 400,
        stream: false
      }),
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 20000))
    });
  } catch (err) {
    return { ok: false, code: err.name === "TimeoutError" ? "timeout" : "network", error: err.message };
  }

  if (!res.ok) return { ok: false, code: `http-${res.status}`, error: `模型接口返回 ${res.status}` };

  let raw;
  try { raw = await res.json(); } catch { return { ok: false, code: "bad-json", error: "模型返回的不是 JSON" }; }

  const out = raw?.choices?.[0]?.message?.content;
  if (!out) return { ok: false, code: "empty", error: "模型没有返回内容" };

  let j;
  try {
    j = JSON.parse(String(out).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch {
    return { ok: false, code: "bad-json", error: "模型输出的不是合法 JSON", detail: String(out).slice(0, 200) };
  }

  const INTENTS = new Set(["new_task", "cancel_task", "complete_task", "supplement_time", "query", "chat"]);
  const intent = INTENTS.has(j.intent) ? j.intent : "chat";

  return {
    ok: true,
    intent,
    target: String(j.target || "").trim(),
    time: String(j.time || "").trim(),
    reply: String(j.reply || "").trim(),
    confidence: Number(j.confidence) || 0,
    latencyMs: Date.now() - started,
    usage: raw?.usage ? {
      inputTokens: raw.usage.prompt_tokens ?? 0,
      outputTokens: raw.usage.completion_tokens ?? 0,
      costCNY: costCNY(raw.usage)
    } : null,
    model: cfg.model
  };
}

// 配置页里的「连通性测试」：发一句最小的请求，确认 key、地址、模型名都对。
export async function llmProbe(config) {
  const cfg = llmConfig(config);
  if (!llmReady(cfg)) return { ok: false, error: "还没填 API Key" };

  const started = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "只回复两个字：收到" }],
        max_tokens: 16,
        temperature: 0
      }),
      signal: AbortSignal.timeout(20000)
    });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      const map = { 401: "API Key 不对", 402: "余额不足", 429: "被限流了" };
      return { ok: false, error: map[res.status] || `接口返回 ${res.status}`, latencyMs: elapsed };
    }
    const data = await res.json();
    return {
      ok: true,
      latencyMs: elapsed,
      model: cfg.model,
      reply: String(data?.choices?.[0]?.message?.content || "").slice(0, 30),
      costCNY: costCNY(data?.usage)
    };
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    return { ok: false, error: timeout ? "20 秒没响应" : err.message, latencyMs: Date.now() - started };
  }
}
