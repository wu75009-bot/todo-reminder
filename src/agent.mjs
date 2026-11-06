// 通用「模型 + 工具」循环：模型决定调哪个工具，工具在本地执行，结果回填后再让模型开口说话。
// 只负责协议，不碰业务，业务工具由调用方注入（见 server.mjs 的 QQ_TOOLS）。

function tidyMessage(msg) {
  // DeepSeek 推理模型会带 reasoning_content，回传时只保留 role / content / tool_calls
  const out = { role: "assistant", content: msg.content || "" };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    out.tool_calls = msg.tool_calls.map(c => ({
      id: c.id,
      type: "function",
      function: { name: c.function?.name || "", arguments: c.function?.arguments || "{}" }
    }));
  }
  return out;
}

export async function runWithTools({
  cfg,
  messages,
  tools,
  onToolCall,
  maxRounds = 5,
  temperature = 0.3,
  timeoutMs = 60000,
  onRound
}) {
  const convo = messages.map(m => ({ ...m }));

  for (let round = 0; round < maxRounds; round++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let json;
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: convo,
          tools,
          tool_choice: "auto",
          temperature,
          max_tokens: cfg.maxTokens || 3000,
          // 字段名是 reasoning_effort，不是 effort。写错时接口不报错、静默忽略（踩过）。
          ...(cfg.effort ? { reasoning_effort: cfg.effort } : {}),
          stream: false
        }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, code: `http-${res.status}`, error: `模型接口返回 ${res.status}`, detail: body.slice(0, 300), convo };
      }
      json = await res.json();
    } catch (err) {
      const msg = err.name === "AbortError" ? "模型响应超时" : err.message;
      return { ok: false, code: err.name === "AbortError" ? "timeout" : "network", error: msg, convo };
    } finally {
      clearTimeout(timer);
    }

    const msg = json?.choices?.[0]?.message;
    if (!msg) return { ok: false, code: "empty", error: "模型没有返回内容", convo };

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(c => c?.function?.name) : [];

    if (!calls.length) {
      convo.push({ role: "assistant", content: msg.content || "" });
      return { ok: true, reply: String(msg.content || "").trim(), convo, rounds: round + 1, usage: json?.usage };
    }

    convo.push(tidyMessage(msg));

    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { args = {}; }
      onRound?.(c.function.name, args);
      let out;
      try {
        out = await onToolCall(c.function.name, args);
      } catch (err) {
        out = { ok: false, error: err.message };
      }
      convo.push({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify(out ?? { ok: true }).slice(0, 3000)
      });
    }
  }

  return { ok: false, code: "too-many-rounds", error: "工具调用轮次过多", convo };
}
