// 长期记忆：把「聊过的事」存下来，不再只有待办能活过一天。
//
// 设计上的三条硬约束：
// 1. 落盘。进程重启、服务器重启都不该忘事，所以存 data/memory.json。
// 2. 不进 system prompt。提示词必须保持完全静态，否则 DeepSeek 的上下文缓存
//    每轮都命不中（每条消息多花一次全价）。记忆拼在 user 消息前面的前缀里，
//    system + 历史那一段前缀仍然是稳定的，缓存照样命中。
// 3. 有上限、可遗忘。记忆不是日志，堆到几千条等于没有。超过上限丢最旧的。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_ITEMS = 300;        // 存多少条
const MAX_CHARS = 240;        // 单条最长，再长就是流水账，不是记忆
const RENDER_LIMIT = 50;      // 每次注入多少条
const RENDER_TOTAL = 2600;    // 注入总字数上限，防止把上下文撑爆

function norm(s) {
  return String(s || "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、,.!?~～:：;；"'“”‘’()（）]/g, "")
    .toLowerCase();
}

function mmdd(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createMemory({ path }) {
  let items = [];
  let dirty = false;

  async function load() {
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const arr = Array.isArray(raw) ? raw : raw?.items;
      if (Array.isArray(arr)) {
        items = arr
          .filter(x => x && typeof x.text === "string" && x.text.trim())
          .map(x => ({
            id: x.id || randomUUID(),
            at: x.at || new Date().toISOString(),
            scope: x.scope || "*",
            tag: x.tag || "fact",
            text: String(x.text).trim().slice(0, MAX_CHARS),
            by: x.by || ""
          }))
          .slice(-MAX_ITEMS);
      }
    } catch { /* 第一次跑 */ }
    return items.length;
  }

  async function save() {
    try {
      await mkdir(dirname(path), { recursive: true });
      // 先写临时文件再改名：中途断电也不会留下半个 JSON 把记忆全毁掉。
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(items, null, 1), "utf8");
      await writeFile(path, JSON.stringify(items, null, 1), "utf8");
      dirty = false;
    } catch { /* 存不进去不该影响对话 */ }
  }

  // 同一句话（去掉标点空白后一样）不重复存，只把时间往前挪。
  function add({ text, scope = "*", tag = "fact", by = "" } = {}) {
    const clean = String(text || "").trim().replace(/\s+/g, " ").slice(0, MAX_CHARS);
    if (!clean) return { ok: false, error: "内容是空的" };

    const key = norm(clean);
    const same = items.find(x => norm(x.text) === key);
    if (same) {
      same.at = new Date().toISOString();
      if (scope && scope !== "*") same.scope = scope;
      dirty = true;
      return { ok: true, dup: true, item: same };
    }

    const item = {
      id: randomUUID(),
      at: new Date().toISOString(),
      scope: scope || "*",
      tag,
      text: clean,
      by
    };
    items.push(item);
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    dirty = true;
    return { ok: true, dup: false, item };
  }

  // 按关键词删。match 空就不删，避免「一句忘掉」把记忆清空。
  function remove(match) {
    const key = norm(match);
    if (!key) return { ok: false, error: "要说明忘掉哪一条" };
    const keep = [];
    const gone = [];
    for (const it of items) {
      if (norm(it.text).includes(key)) gone.push(it);
      else keep.push(it);
    }
    if (!gone.length) return { ok: false, error: `没找到含「${match}」的记忆` };
    items = keep;
    dirty = true;
    return { ok: true, removed: gone.length, items: gone.map(x => x.text) };
  }

  // scope 为空 = 只要全局记忆；传群号 = 该群的记忆 + 全局记忆。
  // includeGlobal=false 用于群里的外人说话：全局记忆多半是主人的私事
  // （在哪、叫什么、什么学校），不能因为别人在群里问一句就抖出去。
  function list({ scope = "*", limit = RENDER_LIMIT, includeGlobal = true } = {}) {
    const hit = items.filter(x => {
      if (x.scope === "*") return includeGlobal;
      return Boolean(scope) && scope !== "*" && x.scope === scope;
    });
    return hit.slice(-limit).reverse();
  }

  // 拼成注入文本。没有记忆时返回空串，调用方据此决定要不要加前缀。
  function render({ scope = "*", limit = RENDER_LIMIT, includeGlobal = true } = {}) {
    const rows = list({ scope, limit, includeGlobal });
    if (!rows.length) return "";

    const lines = [];
    let used = 0;
    for (const it of rows) {
      const line = `- ${mmdd(it.at)} ${it.text}`;
      if (used + line.length > RENDER_TOTAL) break;
      used += line.length + 1;
      lines.push(line);
    }
    if (!lines.length) return "";
    return `【我记得的事】（共 ${items.length} 条，这里列 ${lines.length} 条，越靠前越新）\n${lines.join("\n")}`;
  }

  function count() { return items.length; }

  return { load, save, add, remove, list, render, count, get dirty() { return dirty; } };
}
