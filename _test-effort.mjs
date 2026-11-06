import { readFile } from "node:fs/promises";
import { llmConfig } from "./src/llm.mjs";
import { runWithTools } from "./src/agent.mjs";

const cfg0 = JSON.parse(await readFile("data/config.json", "utf8"));
const cfg = llmConfig(cfg0.llm);
console.log("effort =", cfg.effort);

const r = await runWithTools({
  cfg,
  messages: [
    { role: "system", content: "你是群里的同学，回答问题认真但口语化，简短。" },
    { role: "user", content: "量子纠缠到底能不能用来超光速通信？一句话说清楚。" }
  ],
  tools: [],
  maxRounds: 1,
  timeoutMs: 60000
});
console.log("ok =", r.ok, "| 耗时", r.usage ? "" : "", r.error || "");
console.log("回复：", r.reply);
console.log("tokens:", r.usage);
