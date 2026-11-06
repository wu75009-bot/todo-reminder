import { readFile } from "node:fs/promises";
const cfg = JSON.parse(await readFile("data/config.json", "utf8")).llm;

async function ask(extra, label) {
  const t0 = Date.now();
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: "你是群里的同学，口语化。" },
        { role: "user", content: "示例县示例村在哪个街道，邮编多少？不确定就说不知道。" }
      ],
      max_tokens: 1400,
      ...extra
    })
  });
  const j = await res.json();
  const m = j?.choices?.[0]?.message;
  const u = j?.usage;
  console.log(`【${label}】${((Date.now()-t0)/1000).toFixed(1)}s finish=${j?.choices?.[0]?.finish_reason}`);
  console.log("  reasoning_tokens:", u?.completion_tokens_details?.reasoning_tokens, "| out:", u?.completion_tokens);
  console.log("  答:", String(m?.content || "").slice(0, 80));
}

await ask({ effort: "max" }, "effort=max（我们现在用的字段）");
await ask({ reasoning_effort: "max" }, "reasoning_effort=max（官方字段）");
await ask({ reasoning_effort: "low" }, "reasoning_effort=low");
await ask({ reasoning_effort: "none" }, "reasoning_effort=none（关思考）");
