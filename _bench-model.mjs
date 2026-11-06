// 模型档位对比：同一个问题，看 flash(high) / flash(max) / pro(max) 的回答差别。
// 跑法：node _bench-model.mjs
import { readFile } from "node:fs/promises";

const c = JSON.parse(await readFile("data/config.json", "utf8")).llm;

const QUESTIONS = [
  "我周三下午2点到5点有实验课，周四早上9点要交实验报告，今晚7点还要开班会。你觉得我该怎么安排时间写这份报告？",
  "班长说「下周三之前把表格交给学委」，今天周三。最晚哪天交？",
  "宿舍网突然断了，手机上显示已连接WiFi但没网络，能上网的同学也是这情况。我该怎么办？"
];

async function ask(model, effort, q) {
  const body = {
    model,
    messages: [
      { role: "system", content: "你是学生身边的私人助理。回答要短、具体、能直接用，像朋友发消息那样，不要用列表和小标题。" },
      { role: "user", content: q }
    ],
    temperature: 0.3,
    max_tokens: 900,
    stream: false
  };
  if (effort) body.effort = effort;
  const t0 = Date.now();
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  const j = await r.json();
  return {
    ms: Date.now() - t0,
    text: String(j.choices?.[0]?.message?.content || j.error?.message || "").trim(),
    think: j.usage?.completion_tokens_details?.reasoning_tokens || 0,
    out: j.usage?.completion_tokens || 0
  };
}

const cases = [
  ["flash / 默认(high)", "deepseek-flash", null],
  ["flash / max", "deepseek-flash", "max"],
  ["pro / max", "deepseek-v4-pro", "max"]
];

for (let i = 0; i < QUESTIONS.length; i++) {
  console.log(`\n${"=".repeat(70)}\n问题 ${i + 1}：${QUESTIONS[i]}\n`);
  for (const [label, model, effort] of cases) {
    const r = await ask(model, effort, QUESTIONS[i]);
    console.log(`--- ${label} （${(r.ms / 1000).toFixed(1)}s，思考 ${r.think} tok，输出 ${r.out - r.think} tok）`);
    console.log(r.text || "(空)");
    console.log();
  }
}
