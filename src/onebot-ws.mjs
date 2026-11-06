// NapCat 事件订阅（WebSocket 通道）。
//
// 为什么需要这个：我们现在走的是 NapCat 的「HTTP 上报」——它把事件 POST 到
// /api/onebot。在 Windows 上这条一直好好的，但迁到 Linux 云服务器后不一定：
// 社区实录里有人遇到过 HTTP 上报「服务显示已启动、实际一条事件都不推」，
// SSE 也是连上就断，最后只有 WebSocket 稳定工作。
//
// 所以多留一条路：我们作为客户端去连 NapCat 的 WS 服务（默认 ws://127.0.0.1:3001），
// 收到的事件喂给同一个 handleOneBot。两条通道可以同时开——
// 私聊消息按 message_id 去重，不会因为收了两遍就处理两遍。

const RETRY_MIN = 3_000;
const RETRY_MAX = 30_000;
// 握手超时：TCP 通了但对方一直不回 101，就不能干等着。
// 真实遇到过——容器刚起、QQ 还没登录时，NapCat 的 WS 服务没开，docker-proxy 却先把
// TCP 接了下来，于是 WebSocket 既不开也不 close，永远挂着，一条消息都收不到。
const HANDSHAKE_MS = 15_000;

export function startOneBotWs({ url, token = "", log = () => {}, onEvent, handshakeMs = HANDSHAKE_MS }) {
  if (typeof WebSocket === "undefined") {
    log("这个 Node 版本没有内置 WebSocket（需要 22+），WS 通道没启用");
    return { stop() {}, status: () => ({ running: false }) };
  }
  if (!url) return { stop() {}, status: () => ({ running: false }) };

  let ws = null;
  let stopped = false;
  let wait = RETRY_MIN;
  let timer = null;
  let connected = false;

  const target = () => {
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}access_token=${encodeURIComponent(token)}`;
  };

  function schedule(reason) {
    if (stopped) return;
    connected = false;
    const delay = Math.round(wait * (0.8 + Math.random() * 0.4));
    log(`WS 断开（${reason}），${Math.round(delay / 1000)} 秒后重连`);
    timer = setTimeout(connect, delay);
    wait = Math.min(RETRY_MAX, Math.round(wait * 1.6));
  }

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = new WebSocket(target()); } catch (err) {
      return schedule(err.message);
    }
    ws = sock;

    // 这条连接只允许结算一次：open 之后的 close、以及握手超时，谁先到算谁的，
    // 否则会排两个重连定时器，越滚越多。
    let settled = false;
    let handshake = null;
    const settle = reason => {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      connected = false;
      if (ws === sock) ws = null;
      schedule(reason);
    };

    handshake = setTimeout(() => {
      if (settled) return;
      try { sock.close(); } catch { /* ignore */ }
      settle(`握手 ${Math.round(handshakeMs / 1000)} 秒没成`);
    }, handshakeMs);

    sock.addEventListener("open", () => {
      clearTimeout(handshake);
      wait = RETRY_MIN;
      connected = true;
      log("WS 已连上 NapCat，事件从这个通道收");
    });

    sock.addEventListener("message", ev => {
      let data = ev.data;
      if (typeof data !== "string") return;
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      // 心跳、生命周期之类不是消息，跳过
      if (payload?.post_type !== "message") return;
      Promise.resolve()
        .then(() => onEvent?.(payload))
        .catch(err => log("处理 WS 事件出错：", err.message));
    });

    sock.addEventListener("error", () => { /* close 会紧跟着来，统一在那里重连 */ });

    sock.addEventListener("close", ev => settle(`code=${ev?.code ?? "?"}`));
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
    },
    status() {
      return { running: connected, url };
    }
  };
}
