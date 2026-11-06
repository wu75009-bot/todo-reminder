import { ocrImage } from "./src/push.mjs";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// 用法：TEST_IMG=/path/to/screenshot.png node _test-ocr.mjs
// 不设 TEST_IMG 就安静退出，免得 CI 或别人一跑就报错。
const src = process.env.TEST_IMG || "";
if (!src) {
  console.log("跳过：没设 TEST_IMG 环境变量（这是一条手工验证脚本，需要一张群通知截图）");
  process.exit(0);
}
mkdirSync(join(import.meta.dirname, "data", "tmp"), { recursive: true });
const dst = join(import.meta.dirname, "data", "tmp", "test-card.png");
copyFileSync(src, dst);

const r = await ocrImage(dst);
console.log("ok:", r.ok);
if (r.ok) {
  console.log("行数:", r.lines);
  console.log("--- 识别到的文字 ---");
  console.log(r.text);
  const { parse } = await import("./src/parser.mjs");
  const { RuleBook } = await import("./src/rules.mjs");
  const rules = await new RuleBook("./rules").load();
  const p = parse(r.text, { rules });
  console.log("--- 解析结果 ---");
  console.log("类型:", p.typeName, "标题:", p.title);
  console.log("start:", p.start, " end:", p.end, " due:", p.due);
} else {
  console.log("失败原因:", r.error);
}
