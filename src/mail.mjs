// 极简 SMTP 发信（零依赖，只用 node:tls）。
//
// 用途：QQ 小号掉线时给主人发一封邮件。为什么邮件而不是 QQ 消息——
// 掉线的时候 QQ 这条路正好是断的，告警必须走一条独立于 QQ 的通道。
//
// 只实现「隐式 TLS + AUTH LOGIN + 纯文本正文」这一条最常用路径（QQ/163/126 都支持 465），
// 不追求通用性：不解析多收件人、不带附件、不走 STARTTLS 升级。

import tls from "node:tls";
import { randomBytes } from "node:crypto";

const TIMEOUT_MS = 20_000;

const b64 = s => Buffer.from(String(s), "utf8").toString("base64");
// 中文标题必须编成 MIME encoded-word，否则会变乱码或直接被拒
const mimeWord = s => `=?UTF-8?B?${b64(s)}?=`;
const chunk76 = s => s.replace(/(.{76})/g, "$1\r\n");

/**
 * 发一封纯文本邮件。
 * cfg: { host, port, user, pass, to }
 */
export function sendMail(cfg = {}, { subject = "通知", text = "" } = {}) {
  const host = cfg.host || "smtp.qq.com";
  const port = Number(cfg.port || 465);
  const user = cfg.user || "";
  const pass = cfg.pass || "";
  const rcpt = cfg.to || user;

  if (!user || !pass) return Promise.reject(new Error("缺少发件邮箱或授权码"));

  return new Promise((resolve, reject) => {
    let sock = null;
    let buf = "";
    let waiter = null;
    let finished = false;

    const timer = setTimeout(() => fail(new Error(`SMTP 超时（${TIMEOUT_MS / 1000}s）`)), TIMEOUT_MS);

    function fail(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      reject(err);
    }
    function done(value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock?.end(); } catch { /* ignore */ }
      resolve(value);
    }

    // 读一次完整响应：以「三位码 + 空格」的行收尾，带连字符的是续行
    function read() {
      return new Promise(resolve => {
        const attempt = () => {
          const idx = buf.lastIndexOf("\r\n");
          if (idx < 0) return false;
          const text = buf.slice(0, idx);
          const lines = text.split("\r\n");
          const last = lines[lines.length - 1] || "";
          if (/^\d{3} /.test(last)) {
            buf = buf.slice(idx + 2);
            resolve({ code: Number(last.slice(0, 3)), text });
            return true;
          }
          return false;
        };
        if (attempt()) return;
        waiter = attempt;
      });
    }

    async function cmd(line, expect) {
      sock.write(line + "\r\n");
      const res = await read();
      if (expect && !expect.includes(res.code)) {
        throw new Error(`SMTP ${line.split(" ")[0]} 返回 ${res.code}：${res.text.slice(0, 160)}`);
      }
      return res;
    }

    async function run() {
      // ServerName 只对域名有意义，传 IP 会被 RFC 6066 忽略并告警
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
      sock = tls.connect({
        host,
        port,
        ...(isIp ? {} : { servername: host }),
        rejectUnauthorized: true
      });
      sock.setEncoding("utf8");
      sock.on("data", chunk => {
        buf += chunk;
        if (waiter && waiter()) waiter = null;
      });
      sock.on("error", err => fail(err));
      sock.on("close", () => {
        if (!finished) fail(new Error("SMTP 连接被关闭"));
      });

      const greet = await read();
      if (greet.code !== 220) throw new Error(`SMTP 问候异常：${greet.text.slice(0, 160)}`);

      await cmd("EHLO todo-reminder", [250]);
      await cmd("AUTH LOGIN", [334]);
      await cmd(b64(user), [334]);
      const auth = await cmd(b64(pass), [235]);

      await cmd(`MAIL FROM:<${user}>`, [250]);
      await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
      await cmd("DATA", [354]);

      const headers = [
        `From: ${mimeWord("待办提醒")} <${user}>`,
        `To: <${rcpt}>`,
        `Subject: ${mimeWord(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomBytes(8).toString("hex")}@${host}>`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        ""
      ].join("\r\n");

      sock.write(headers + "\r\n" + chunk76(b64(text)) + "\r\n.\r\n");
      const sent = await read();
      if (sent.code !== 250) throw new Error(`邮件投递失败：${sent.text.slice(0, 160)}`);

      try { sock.write("QUIT\r\n"); } catch { /* ignore */ }
      done({ ok: true, to: rcpt, auth: auth.code });
    }

    run().catch(err => fail(err));
  });
}
