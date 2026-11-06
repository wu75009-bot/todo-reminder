import { readFile } from "node:fs/promises";
import { llmConfig } from "./src/llm.mjs";
import { runWithTools } from "./src/agent.mjs";
import { webSearch, fetchPage, searchToText } from "./src/websearch.mjs";

const cfg = llmConfig(JSON.parse(await readFile("data/config.json", "utf8")).llm);

const tools = [
  { type: "function", function: {
    name: "web_search",
    description: "上网搜索。被问到你不确定的具体事实时用：地名、单位、学校、村、数据、参数、最近的事。",
    parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } }, required: ["query"] }
  }},
  { type: "function", function: {
    name: "fetch_url",
    description: "打开网页读正文，摘要不够时用。",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
  }}
];

async function call(name, args) {
  console.log("   → 工具调用", name, JSON.stringify(args).slice(0, 90));
  if (name === "web_search") {
    const r = await webSearch(args.query);
    return r.ok ? { ok: true, text: searchToText(r).slice(0, 2200) } : { ok: false, error: r.error };
  }
  if (name === "fetch_url") {
    const p = await fetchPage(args.url);
    return p.ok ? { ok: true, title: p.title, text: p.text } : { ok: false, error: p.error };
  }
  return { ok: false, error: "无此工具" };
}

const sys = `你在一个 QQ 群里聊天，群里都是熟人，说话口语化。
有人问到具体事实（某个村、某个学校、某条路、某个数据）时，先 web_search，摘要不够就 fetch_url 读那一页，再回答。
同名的地方很多，确认是不是同一个地方。
搜不到就说搜不到，别编。不知道就别硬答。
简短，像同学说话，别客套。`;

for (const q of ["示例县的示例村知道吗，具体在哪个街道，邮编多少", "示例村那个村大概多少人"]) {
  console.log("\n=== 问：", q);
  const t0 = Date.now();
  const r = await runWithTools({
    cfg, messages: [{ role: "system", content: sys }, { role: "user", content: q }],
    tools, onToolCall: call, maxRounds: 6, timeoutMs: 90000
  });
  console.log(`  ${((Date.now()-t0)/1000).toFixed(1)}s ok=${r.ok} rounds=${r.rounds} effort=${cfg.effort}`);
  console.log("  答：", r.reply || r.error);
}
