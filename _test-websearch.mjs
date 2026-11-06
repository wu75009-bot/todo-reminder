import { webSearch, fetchPage, searchToText } from "./src/websearch.mjs";

for (const q of ["示例县示例村 邮编", "示例省 示例县 示例街道 示例村"]) {
  const r = await webSearch(q);
  console.log("\n=====", q, "| ok", r.ok, r.engine || r.error, r.cached ? "(缓存)" : "");
  console.log(searchToText(r).slice(0, 700));
}

const r = await webSearch("示例县 示例村 示例街道");
if (r.ok) {
  const p = await fetchPage(r.results[0].url);
  console.log("\n===== 读页:", r.results[0].url, "ok", p.ok);
  console.log("标题:", p.title);
  console.log((p.text || p.error).slice(0, 500));
}
