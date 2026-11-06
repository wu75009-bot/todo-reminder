import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PS = "powershell.exe";
// 桌面通知和 OCR 都是 Windows 独有（走 PowerShell + WinRT）。
// 搬到 Linux 云服务器后这两块没有对应实现：toast 本来就已经关了，
// OCR 也只是图片识别的兜底——图片默认是直接给模型看的，缺了它照样能用。
const IS_WIN = process.platform === "win32";
const here = fileURLToPath(new URL(".", import.meta.url));
// 不用系统临时目录：Windows 的 %TEMP% 常是 8.3 短路径（LIKAIC~1），
// WinRT 的 StorageFile 对短路径会直接失败，所以用项目内自己的目录。
const WORK = process.env.TODO_TMP || join(here, "..", "data", "tmp");
mkdirSync(WORK, { recursive: true });

export function workFile(name) {
  return join(WORK, name);
}

function runPS(scriptPath, payload) {
  return new Promise(async (res, rej) => {
    let payloadPath;
    try {
      payloadPath = join(WORK, `payload-${randomUUID()}.json`);
      await writeFile(payloadPath, JSON.stringify(payload), "utf8");
      const child = spawn(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, payloadPath], {
        windowsHide: true
      });
      let out = "";
      child.stdout.on("data", d => { out += d.toString(); });
      child.stderr.on("data", d => { out += d.toString(); });
      child.on("error", err => rej(err));
      child.on("close", code => {
        unlink(payloadPath).catch(() => {});
        res({ code, out });
      });
    } catch (err) {
      rej(err);
    }
  });
}

// 系统托盘通知。失败不抛错——网页里的收件箱是兜底通道。
export async function toast(title, body) {
  if (!IS_WIN) return { ok: false, skipped: true, detail: "非 Windows 环境没有桌面通知" };
  try {
    const r = await runPS(join(here, "toast.ps1"), { title, body });
    return { ok: r.code === 0, detail: r.out.trim() };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function ocrImage(imagePath) {
  if (!IS_WIN) return { ok: false, skipped: true, error: "非 Windows 环境没有系统 OCR，图片直接交给模型看" };
  const outPath = workFile(`ocr-${randomUUID()}.json`);
  const r = await runPS(join(here, "ocr.ps1"), { image: imagePath, out: outPath });
  try {
    const raw = await readFile(outPath, "utf8");
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data.ok) {
      if (data.code === "no-ocr-language-pack") {
        return { ok: false, error: "系统没装中文 OCR 语言包：设置 → 时间和语言 → 语言和区域 → 中文 → 语言选项 → 可选功能里加「光学字符识别」" };
      }
      return { ok: false, error: data.error || "识别失败" };
    }
    return { ...data, text: tidyOcr(data.text), raw: data.text };
  } catch (err) {
    return { ok: false, error: `OCR 没跑起来：${r.out.trim() || err.message}` };
  } finally {
    unlink(outPath).catch(() => {});
  }
}

// Windows OCR 会在中文字之间插空格，还常把 - 认成 一、把 : 认成全角。
// 这几步只做确定性修正，不改字面内容。
export function tidyOcr(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/[—–−~～﹣ー]/g, "-")
    .replace(/：/g, ":")
    .replace(/(?<=\d)\s*[一丨|]\s*(?=\d)/g, "-")
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "")
    .replace(/(?<=\d)\s+(?=[\u4e00-\u9fa5])/g, "")
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=\d)/g, "")
    .replace(/\s*([:\-])\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// 外部推送：微信（PushPlus / Server酱）或任意 webhook。配置在 data/config.json。
export async function webhook(config, { title, body }) {
  const w = config?.webhook;
  if (!w || !w.enabled) return { ok: false, skipped: true };
  try {
    let res;
    if (w.type === "pushplus") {
      res = await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: w.token, title, content: body, template: "txt" })
      });
    } else if (w.type === "serverchan") {
      res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(w.token)}.send`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title, desp: body }).toString()
      });
    } else if (w.type === "wxpusher") {
      // 极简推送：token 填 SPT_ 开头那串，扫码就能拿，不用建应用
      const spt = String(w.token || "").trim();
      if (!spt) return { ok: false, skipped: true };
      const text = `${title}\n${body || ""}`.slice(0, 500);
      res = await fetch(`https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(spt)}/${encodeURIComponent(text)}`, {
        method: "GET"
      });
      const j = await res.json().catch(() => null);
      return { ok: Boolean(j && j.code === 1000), status: res.status, detail: j?.msg };
    } else {
      if (!w.url) return { ok: false, skipped: true };
      res = await fetch(w.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(w.headers || {}) },
        body: JSON.stringify({ title, body })
      });
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
