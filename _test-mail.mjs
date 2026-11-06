// mail.mjs 的回归测试。不发真实邮件，只验证「出错时能干净地失败」——
// 告警通道最怕的是悄悄不工作，所以这里盯的是失败路径而不是快乐路径。
//
// 真实发信靠手工验证一次（2026-11-06 已通过，auth 235 / 投递 250）。
// 跑法：node _test-mail.mjs

import { sendMail } from "./src/mail.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("1. 配置缺失要快速拒绝");
{
  const t0 = Date.now();
  let err = null;
  try { await sendMail({}, { subject: "x", text: "y" }); } catch (e) { err = e; }
  ok("空配置被拒绝", Boolean(err), "（居然没报错）");
  ok("错误信息可读", /授权码|邮箱/.test(err?.message || ""), err?.message);
  ok("没有卡住", Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
}

console.log("2. 只有邮箱没有授权码也要拒绝");
{
  let err = null;
  try {
    await sendMail({ user: "a@qq.com", to: "a@qq.com" }, { subject: "x", text: "y" });
  } catch (e) { err = e; }
  ok("缺授权码被拒绝", Boolean(err), "（居然没报错）");
}

console.log("3. 连不上服务器要报错而不是挂死");
{
  const t0 = Date.now();
  let err = null;
  try {
    await sendMail(
      { host: "127.0.0.1", port: 9, user: "a@qq.com", pass: "x", to: "a@qq.com" },
      { subject: "x", text: "y" }
    );
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok("连接失败有错误", Boolean(err), "（居然没报错）");
  ok("没有等到超时才失败", ms < 15_000, `${ms}ms`);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
