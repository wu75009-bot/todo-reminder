import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

// 常驻一个 PowerShell 进程盯着剪贴板，比每次调用 Get-Clipboard 起一个进程省得多。
// 进程挂了自动重来，指数退避最多 30 秒——不然脚本一报错就永久失去自动识别。
export function startClipboardWatcher({ root, onEvent, log = () => {}, intervalMs = 350 }) {
  // 剪贴板是 Windows 专属（PowerShell 的 GetClipboardSequenceNumber）。
  // 云服务器上没有剪贴板这个概念，静默跳过，别让服务起不来。
  if (process.platform !== "win32") {
    log("剪贴板监听只在 Windows 上有，已跳过");
    return { stop() {}, status: () => ({ running: false, ready: false, restarts: 0, skipped: true }) };
  }
  const script = join(root, "src", "clipboard.ps1");
  let child = null;
  let stopped = false;
  let restarts = 0;
  let ready = false;

  function launch() {
    if (stopped) return;
    child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-IntervalMs", String(intervalMs)
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", line => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      if (ev.event === "ready") { ready = true; restarts = 0; log(`剪贴板监听就绪（间隔 ${ev.interval}ms）`); }
      try { onEvent(ev); } catch (e) { log("处理剪贴板事件出错：", e.message); }
    });

    child.stderr.on("data", d => {
      const s = String(d).trim();
      if (s) log("剪贴板脚本的输出：", s.slice(0, 300));
    });

    child.on("error", err => log("起不了剪贴板脚本：", err.message));

    child.on("exit", code => {
      ready = false;
      if (stopped) return;
      restarts += 1;
      const wait = Math.min(30_000, 1000 * restarts);
      log(`剪贴板监听退出了（code=${code}），${Math.round(wait / 1000)} 秒后重来`);
      setTimeout(launch, wait);
    });
  }

  launch();

  return {
    stop() {
      stopped = true;
      try { child?.kill(); } catch { /* ignore */ }
    },
    status() {
      return { running: Boolean(child) && !child.killed && !stopped, ready, restarts };
    }
  };
}
