// 长期记忆模块的回归测试。node _test-memory.mjs
// 只测纯逻辑，不联网、不起服务。
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory } from "./src/memory.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const dir = await mkdtemp(join(tmpdir(), "todo-mem-"));
const path = join(dir, "memory.json");

try {
  console.log("\n[1] 空记忆不注入");
  {
    const m = createMemory({ path });
    await m.load();
    ok("新库条数为 0", m.count() === 0);
    ok("render 返回空串（调用方据此不加前缀）", m.render({}) === "");
  }

  console.log("\n[2] 存、读、渲染");
  {
    const m = createMemory({ path });
    await m.load();
    m.add({ text: "主人在某省示例县，念大学" });
    m.add({ text: "群里那个「示例昵称甲」是张三", scope: "g:123" });
    await m.save();

    const txt = m.render({});
    ok("全局能看到主人信息", txt.includes("示例县"));
    ok("全局看不到某个群的外号", !txt.includes("张三"));

    const g = m.render({ scope: "g:123" });
    ok("群视角能看到本群记忆", g.includes("张三"));
    ok("群视角也能看到全局记忆", g.includes("示例县"));

    const other = m.render({ scope: "g:999" });
    ok("别的群看不到这个群的记忆", !other.includes("张三"));

    const stranger = m.render({ scope: "g:123", includeGlobal: false });
    ok("群里外人说话不泄露主人的私事", !stranger.includes("示例县"), stranger.slice(0, 60));
    ok("群里外人仍能看到本群的事", stranger.includes("张三"));

    ok("渲染带条数头", txt.startsWith("【我记得的事】"));
  }

  console.log("\n[3] 去重");
  {
    const m = createMemory({ path });
    await m.load();
    const before = m.count();
    const r = m.add({ text: "主人在某省示例县，念大学。" });   // 只多了个句号
    ok("同一句不重复存", r.dup === true && m.count() === before, `count=${m.count()}`);
  }

  console.log("\n[4] 重启不丢（真的重新读盘）");
  {
    const m2 = createMemory({ path });
    const n = await m2.load();
    ok("重新加载后有内容", n >= 2, `n=${n}`);
    ok("内容还在", m2.render({ scope: "g:123" }).includes("张三"));
  }

  console.log("\n[5] 删除");
  {
    const m = createMemory({ path });
    await m.load();
    const bad = m.remove("");                        // 空关键词不许清库
    ok("空关键词拒绝删除", bad.ok === false);
    const miss = m.remove("不存在的东西");
    ok("找不到时不报成功", miss.ok === false && /没找到/.test(miss.error));
    const hit = m.remove("示例县");
    ok("按关键词删掉", hit.ok === true && hit.removed === 1);
    ok("删完就查不到了", !m.render({}).includes("示例县"));
    await m.save();
  }

  console.log("\n[6] 上限与截断");
  {
    const m = createMemory({ path: join(dir, "big.json") });
    await m.load();
    for (let i = 0; i < 340; i++) m.add({ text: `第 ${i} 条记忆内容` });
    ok("不会无限增长", m.count() <= 300, `count=${m.count()}`);
    ok("保留的是最近的", m.render({}).includes("第 339 条"));
    ok("最旧的被丢掉", !m.render({ limit: 300 }).includes("第 0 条"));

    const long = m.add({ text: "啊".repeat(500) });
    ok("单条被截断到 240 字", long.item.text.length <= 240, `len=${long.item.text.length}`);
  }

  console.log("\n[7] 坏文件不炸");
  {
    const p2 = join(dir, "broken.json");
    await writeFile(p2, "{ 这不是 json", "utf8");
    const m = createMemory({ path: p2 });
    let threw = false;
    try { await m.load(); } catch { threw = true; }
    ok("坏 JSON 不抛异常（宁可当空库）", !threw);
    ok("坏文件后仍然能写入", m.add({ text: "还能记" }).ok === true);
    await m.save();
    const back = JSON.parse(await readFile(p2, "utf8"));
    ok("写回的是合法 JSON", Array.isArray(back) && back.length === 1);
  }

  console.log("\n[8] 注入长度有上限");
  {
    const m = createMemory({ path: join(dir, "long.json") });
    await m.load();
    for (let i = 0; i < 60; i++) m.add({ text: `${i} ` + "内容".repeat(80) });
    const txt = m.render({});
    ok("不会把上下文撑爆", txt.length < 3200, `len=${txt.length}`);
    ok("仍然是有内容可用的", txt.split("\n").length > 3);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
