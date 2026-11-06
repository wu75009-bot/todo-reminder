import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 规则目录：rules/*.json，一个任务类型一个文件。改完自动生效，不用重启。
export class RuleBook {
  constructor(dir) {
    this.dir = dir;
    this.rules = [];
    this.error = null;
  }

  async load() {
    this.error = null;
    const files = (await readdir(this.dir)).filter(f => f.toLowerCase().endsWith(".json")).sort();
    const rules = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), "utf8");
        const data = JSON.parse(raw);
        rules.push({
          ...data,
          file,
          id: data.id || file.replace(/\.json$/i, ""),
          priority: Number(data.priority || 0),
          match: Array.isArray(data.match) ? data.match : [],
          reminders: Array.isArray(data.reminders) ? data.reminders : []
        });
      } catch (err) {
        this.error = `${file} 解析失败：${err.message}`;
      }
    }
    rules.sort((a, b) => b.priority - a.priority);
    this.rules = rules;
    return rules;
  }

  byFile(file) {
    return this.rules.find(r => r.file === file) || null;
  }

  async save(file, data) {
    if (!/^[\w\u4e00-\u9fa5-]+\.json$/i.test(file)) throw new Error("文件名不合法");
    const merged = { ...data, priority: Number(data.priority || 0) };
    await writeFile(join(this.dir, file), JSON.stringify(merged, null, 2) + "\n", "utf8");
    await this.load();
    return merged;
  }
}
