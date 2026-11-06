import { readFile } from "node:fs/promises";
import { llmConfig } from "./src/llm.mjs";
import { runWithTools } from "./src/agent.mjs";

const cfg = llmConfig(JSON.parse(await readFile("data/config.json", "utf8")).llm);

// 尽量还原群里的真实条件：短提示词、无工具、口语、要求不确定就承认
const sys = `你在一个 QQ 群里聊天。群里都是熟人，说话口语化。
有人问你具体问题时，知道的就答全，不知道就说不知道，别编。
不要提你是 AI，不要客套。`;

const qs = [
  "示例县的示例村你去过吗，说说那的情况",
  "示例县示例村有多少人，主要种什么"
];

for (const q of qs) {
  const t0 = Date.now();
  const r = await runWithTools({
    cfg,
    messages: [{ role: "system", content: sys }, { role: "user", content: q }],
    tools: [],
    maxRounds: 1,
    timeoutMs: 60000
  });
  console.log("\n=== Q:", q);
  console.log("耗时", ((Date.now()-t0)/1000).toFixed(1)+"s", "| ok", r.ok);
  console.log(r.reply || r.error);
  console.log("reasoning tokens:", r.usage?.completion_tokens_details?.reasoning_tokens);
}
