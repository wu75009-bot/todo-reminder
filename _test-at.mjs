// @ 段解析的回归测试。node _test-at.mjs
// 背景：以前 readMessage 只认 text/image/forward，at 段被整个丢掉，
// 群里「@某某 这个」到模型那边只剩「 这个」，于是它回「名字也没出现」。
import { readMessage } from "./src/onebot.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// 指向不存在的端口：只要不打网络请求就算对，打了一定会慢/失败
const deadCfg = { api: "http://127.0.0.1:3997", token: "" };

console.log("\n[1] at 段自带名字（NapCat 大多数情况下会带）");
{
  const msg = [
    { type: "at", data: { qq: "10003", name: "示例昵称甲" } },
    { type: "text", data: { text: " 这个" } }
  ];
  const r = await readMessage(deadCfg, msg);
  ok("名字出现在文本里", r.text.includes("示例昵称甲"), r.text);
  ok("后面的文字还在", r.text.includes("这个"), r.text);
  ok("没有残留空 @", !/@\s*$/.test(r.text.trim()), r.text);
}

console.log("\n[2] at 段只有 QQ 号、又没给群号（私聊场景）");
{
  const msg = [{ type: "at", data: { qq: "10003" } }, { type: "text", data: { text: " 看下" } }];
  const r = await readMessage(deadCfg, msg);
  ok("退化成 @QQ号，但不丢", r.text.includes("@10003"), r.text);
}

console.log("\n[3] @全体成员");
{
  const r = await readMessage(deadCfg, [{ type: "at", data: { qq: "all" } }, { type: "text", data: { text: " 开会" } }]);
  ok("认得出全体成员", r.text.includes("@全体成员"), r.text);
}

console.log("\n[4] 多个 at + 文字混排，顺序不乱");
{
  const msg = [
    { type: "text", data: { text: "问一下" } },
    { type: "at", data: { qq: "1", name: "甲" } },
    { type: "text", data: { text: "和" } },
    { type: "at", data: { qq: "2", name: "乙" } }
  ];
  const r = await readMessage(deadCfg, msg);
  ok("两个人都提到了", r.text.includes("@甲") && r.text.includes("@乙"), r.text);
  ok("顺序保持原样", r.text.indexOf("问一下") < r.text.indexOf("@甲"), r.text);
}

console.log("\n[5] 没有 at 的普通消息不受影响");
{
  const r = await readMessage(deadCfg, [{ type: "text", data: { text: "纯文字" } }]);
  ok("原样返回", r.text === "纯文字", r.text);
}

console.log("\n[6] 空 at 段不产生垃圾");
{
  const r = await readMessage(deadCfg, [{ type: "at", data: {} }, { type: "text", data: { text: "嗨" } }]);
  ok("不出现孤零零的 @", r.text === "嗨", r.text);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
