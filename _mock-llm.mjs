// 假的 DeepSeek 接口，用来在没有真 key 的情况下验证整条链路。
// 它会按请求内容返回不同剧本，其中包含一次「故意编日期」的幻觉，用来看拦截层是否真的拦得住。
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 3801);

const callLog = [];

function reply(res, content, { promptTokens = 900, completionTokens = 180 } = {}) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "mock-" + Date.now(),
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }));
}

function pickScenario(text, isImage) {
  if (isImage) {
    return {
      type: "考试",
      title: "高等数学期末考试",
      course: "高等数学",
      start: "2026-11-20T19:00:00+08:00",
      end: "2026-11-20T21:00:00+08:00",
      due: null,
      location: "教三 302",
      confidence: 0.9,
      rawText: "【高等数学】期末考试\n考试时间：11-20 19:00 至 11-20 21:00\n地点：教三302",
      evidence: {
        start: "11-20 19:00",
        end: "11-20 21:00"
      },
      notes: []
    };
  }
  if (/HALLUCINATE/.test(text)) {
    // 原文只说「下周交」，没有任何具体数字。模型却「贴心」地给了一个日期。
    return {
      type: "作业",
      title: "实验报告",
      course: "高等数学",
      start: null,
      end: null,
      due: "2026-11-11T23:59:00+08:00",
      location: null,
      confidence: 0.88,
      rawText: text,
      evidence: { due: "下周一开始提交" },
      notes: []
    };
  }
  if (/NO_EVIDENCE/.test(text)) {
    // 有日期，但 evidence 是空的 —— 同样该被拦
    return {
      type: "作业",
      title: "读书报告",
      course: null,
      start: null, end: null,
      due: "2026-11-15T12:00:00+08:00",
      location: null,
      confidence: 0.8,
      rawText: text,
      evidence: {},
      notes: []
    };
  }
  if (/SWAPPED/.test(text)) {
    // 开始结束写反了，应该被自动对调
    return {
      type: "会议",
      title: "组会",
      course: null,
      start: "2026-11-06T17:00:00+08:00",
      end: "2026-11-06T15:00:00+08:00",
      due: null,
      location: "B312",
      confidence: 0.85,
      rawText: text,
      evidence: { start: "周五下午三点到五点", end: "周五下午三点到五点" },
      notes: []
    };
  }
  return {
    type: "作业",
    title: "高等数学实验报告",
    course: "高等数学",
    start: null, end: null,
    due: "2026-11-10T23:59:00+08:00",
    location: "教学平台",
    confidence: 0.92,
    rawText: text,
    evidence: { due: "11月10日23:59前提交" },
    notes: []
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/__log") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(callLog));
  }

  if (!url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404); return res.end("{}");
  }

  if (req.headers.authorization !== "Bearer sk-mock-key") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  }

  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
    const userMsg = body.messages?.find(m => m.role === "user");
    const isImage = Array.isArray(userMsg?.content)
      && userMsg.content.some(p => p.type === "image_url");
    const text = Array.isArray(userMsg?.content)
      ? (userMsg.content.find(p => p.type === "text")?.text || "")
      : String(userMsg?.content || "");

    callLog.push({
      at: new Date().toISOString(),
      isImage,
      textLen: text.length,
      model: body.model,
      hasJsonFormat: body.response_format?.type === "json_object",
      temperature: body.temperature
    });

    // 探测请求（连通性测试）走这条
    if (/只回复两个字/.test(text)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        choices: [{ message: { content: "收到" } }],
        usage: { prompt_tokens: 20, completion_tokens: 3 }
      }));
    }

    reply(res, pickScenario(text, isImage));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("mock 模型服务已启动：http://127.0.0.1:" + PORT);
});
