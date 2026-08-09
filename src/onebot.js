// OneBot 11 client for the Windows port.
// Primary transport: forward WebSocket (NapCat default: ws://127.0.0.1:3001).
// Fallback transport: HTTP API (ONEBOT_API_BASE, default http://127.0.0.1:3000).

export const oneBotWsUrl = process.env.ONEBOT_WS_URL || "ws://127.0.0.1:3001";
export const oneBotApiBase = process.env.ONEBOT_API_BASE || "http://127.0.0.1:3000";

let ws = null;
let wsStatus = { connected: false, reason: "not started", lastError: null, connectedAt: null };
const echoWaiters = new Map();
let seq = 0;
let onEvent = null;
let reconnectTimer = null;

function reportStatus(patch) {
  wsStatus = { ...wsStatus, ...patch };
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  let socket;
  try {
    socket = new WebSocket(oneBotWsUrl);
  } catch (error) {
    reportStatus({ connected: false, reason: `connect error: ${error.message}` });
    reconnectTimer = setTimeout(connect, 5000);
    reconnectTimer.unref?.();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    reportStatus({ connected: true, reason: "connected", lastError: null, connectedAt: new Date().toISOString() });
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.echo != null) {
      const waiter = echoWaiters.get(String(data.echo));
      if (waiter) {
        echoWaiters.delete(String(data.echo));
        waiter(data);
      }
      return;
    }
    if (data.post_type === "message" && onEvent) {
      onEvent(data);
    }
  };

  socket.onerror = () => {
    reportStatus({ connected: false, reason: "socket error" });
    if (ws === socket) {
      ws = null;
      for (const waiter of echoWaiters.values()) waiter({ status: "failed", retcode: -1, data: null });
      echoWaiters.clear();
      reconnectTimer = setTimeout(connect, 5000);
      reconnectTimer.unref?.();
    }
  };

  socket.onclose = () => {
    if (ws === socket) {
      reportStatus({ connected: false, reason: "closed" });
      ws = null;
      for (const waiter of echoWaiters.values()) waiter({ status: "failed", retcode: -1, data: null });
      echoWaiters.clear();
      reconnectTimer = setTimeout(connect, 5000);
      reconnectTimer.unref?.();
    }
  };
}

export function startOneBotWS({ onEvent: handler }) {
  onEvent = handler;
  connect();
}

export function getOneBotConnectionStatus() {
  return { ...wsStatus, url: oneBotWsUrl };
}

function sendWsAction(action, params, { timeoutMs = 12000 } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: "OneBot WS not connected" });
  }
  const echo = `crc-${Date.now()}-${seq++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      echoWaiters.delete(echo);
      resolve({ ok: false, error: "OneBot WS action timeout" });
    }, timeoutMs);
    echoWaiters.set(echo, (data) => {
      clearTimeout(timer);
      resolve({ ok: data.status !== "failed", data });
    });
    try {
      ws.send(JSON.stringify({ action, params, echo }));
    } catch (error) {
      clearTimeout(timer);
      echoWaiters.delete(echo);
      resolve({ ok: false, error: error.message });
    }
  });
}

async function sendHttpAction(action, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${oneBotApiBase}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text().catch(() => "") };
    }
    const data = await response.json().catch(() => ({}));
    return { ok: data.status !== "failed", data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendOneBotAction(action, params, options) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const result = await sendWsAction(action, params, options);
    if (result.ok) return result;
    // fall through to HTTP on WS action failure
  }
  return sendHttpAction(action, params);
}

export async function checkOneBotHealth() {
  const login = await sendOneBotAction("get_login_info", {}, { timeoutMs: 5000 });
  if (!login.ok) return { ok: false, reason: login.error || login.reason || `HTTP ${login.status || "?"}` };
  const info = login.data?.data || login.data || {};
  return { ok: true, userId: info.user_id, nickname: info.nickname };
}

export async function sendGroupMessage(groupId, text) {
  return sendOneBotAction("send_group_msg", {
    group_id: Number(groupId),
    message: String(text || "").slice(0, 4000)
  });
}

export async function sendPrivateMessage(userId, text) {
  return sendOneBotAction("send_private_msg", {
    user_id: Number(userId),
    message: String(text || "").slice(0, 4000)
  });
}

export async function sendPrivateImages(userId, imagePaths) {
  const paths = (Array.isArray(imagePaths) ? imagePaths : [imagePaths])
    .filter(Boolean)
    .slice(0, 5);
  if (!paths.length) return { ok: false, error: "no images" };
  const message = paths.map((p) => ({
    type: "image",
    data: { file: `file:///${String(p).replace(/\\/g, "/")}` }
  }));
  return sendOneBotAction("send_private_msg", {
    user_id: Number(userId),
    message
  });
}
