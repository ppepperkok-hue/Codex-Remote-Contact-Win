import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexWorkspaceDir,
  loadQqMemory,
  loadQqPersonas,
  loadRemoteExecutionMemory,
  loadSettings,
  projectDir,
  saveJsonFile,
  saveQqMemory,
  saveQqPersonas,
  saveSettings
} from "./settings.js";
import { checkOneBotHealth, getOneBotConnectionStatus, sendPrivateMessage, startOneBotWS } from "./onebot.js";
import { handleQqEvent, buildHelpText, buildQqStatusLine, normalizeOneBotEvent } from "./qq.js";
import {
  buildRemoteExecutionReply,
  executeRemoteExecutionCommand,
  startIdleTimer,
  stopIdleTimer
} from "./remote-exec.js";
import { listApps, openApp, searchApps } from "./launcher.js";
import { isValidSkillName, listAvailableSkills } from "./skill-loader.js";
import { checkCodexCliStatus, describeCodexCliPath } from "./codex.js";
import { getServicesStatus, startService, stopService } from "./services.js";
import { getWakeInfo, sendWake } from "./wake.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(projectDir, "modules", "web-console", "public");
const systemControlDir = join(projectDir, "modules", "system-control");
const runtimeDir = join(projectDir, "runtime");
const PORT = Number(process.env.CODEX_REMOTE_CONTACT_PORT || 3789);
const HOST = process.env.CODEX_REMOTE_CONTACT_HOST || "127.0.0.1";
const ACCESS_TOKEN = process.env.CODEX_REMOTE_CONTACT_ACCESS_TOKEN || "";

const seenEventKeys = new Map();

function isSeenEvent(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of seenEventKeys) {
    if (now - t > 120000) seenEventKeys.delete(k);
  }
  if (seenEventKeys.has(key)) return true;
  seenEventKeys.set(key, now);
  return false;
}

const state = {
  channels: { qq: true },
  qq: {
    memory: null,
    personas: null,
    events: []
  },
  ai: null,
  lastOpenedApp: null,
  remoteExecution: {
    enabled: false,
    pendingAction: null,
    memory: null,
    idleTimer: null,
    lastActiveAt: 0
  },
  branding: null,
  maintenance: {
    oneBot: { ok: false, checkedAt: null },
    codex: { lastOk: null, lastError: null, lastRunAt: null, cli: "" }
  },
  keepAwake: { child: null }
};

function sendJson(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function requestHasValidToken(req) {
  if (!ACCESS_TOKEN) return true;
  const header = req.headers["x-access-token"] || "";
  const query = (() => {
    try {
      return new URL(req.url || "/", "http://localhost").searchParams.get("access_token") || "";
    } catch {
      return "";
    }
  })();
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `crc_access_token=${ACCESS_TOKEN}`);
  return header === ACCESS_TOKEN || query === ACCESS_TOKEN || cookie;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codex Remote Contact · 访问密码</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #0f1117; color: #e6e6e6; font-family: system-ui, "Microsoft YaHei", sans-serif; }
    .card { background: #1a1d27; border: 1px solid #2c3142; border-radius: 14px; padding: 28px 32px;
            width: min(88vw, 340px); box-shadow: 0 12px 40px rgba(0,0,0,.45); }
    h1 { font-size: 17px; margin: 0 0 6px; }
    p { color: #9aa3b5; font-size: 13px; margin: 0 0 18px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
            border: 1px solid #333a4d; background: #12151d; color: #fff; font-size: 15px; outline: none; }
    input:focus { border-color: #5b8cff; }
    button { width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px;
             background: #4f7cff; color: #fff; font-size: 15px; cursor: pointer; }
    button:active { background: #3f66d8; }
    .err { color: #ff7a7a; font-size: 12px; min-height: 16px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Codex Remote Contact</h1>
    <p>请输入访问密码进入控制台</p>
    <input id="pin" type="password" placeholder="访问密码" autocomplete="current-password" autofocus />
    <button id="go">进入</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    const input = document.getElementById("pin");
    const btn = document.getElementById("go");
    const err = document.getElementById("err");
    function submit() {
      const value = input.value.trim();
      if (!value) { err.textContent = "密码不能为空"; return; }
      document.cookie = "crc_access_token=" + encodeURIComponent(value) +
        "; path=/; max-age=31536000; SameSite=Lax";
      location.reload();
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    setTimeout(() => input.focus(), 50);
  </script>
</body>
</html>`;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildPublicState() {
  return {
    channels: { ...state.channels },
    qq: {
      allowedGroups: state.qq.allowedGroups,
      bannedUserIds: state.qq.bannedUserIds,
      ownerUserIds: state.qq.ownerUserIds,
      recentEvents: state.qq.events.slice(0, 10)
    },
    ai: { ...state.ai },
    remoteExecution: {
      enabled: state.remoteExecution.enabled,
      model: state.remoteExecution.model,
      reasoningEffort: state.remoteExecution.reasoningEffort,
      skill: state.remoteExecution.skill,
      sandbox: state.remoteExecution.sandbox
    },
    lastOpenedApp: state.lastOpenedApp,
    branding: { ...state.branding }
  };
}

async function buildMaintenanceStatus() {
  const oneBot = await checkOneBotHealth();
  state.maintenance.oneBot = { ...oneBot, checkedAt: new Date().toISOString() };
  const codexStatus = await checkCodexCliStatus();
  state.maintenance.codex = { ...state.maintenance.codex, ...codexStatus };
  return {
    oneBot,
    oneBotWs: getOneBotConnectionStatus(),
    codex: state.maintenance.codex,
    memory: {
      qqGroups: Object.keys(state.qq.memory.entries || {}).length,
      qqRecentMessages: Object.values(state.qq.memory.recentMessages || {}).reduce((n, l) => n + l.length, 0),
      remoteExecEntries: (state.remoteExecution.memory.entries || []).length
    }
  };
}

const TUNNEL_LOG_NAMES = {
  3789: "cloudflared.log",
  6099: "cloudflared-6099.log",
  6100: "cloudflared-6100.log",
  6185: "cloudflared-6185.log"
};

async function readTunnelUrl(logName) {
  try {
    const raw = await readFile(join(runtimeDir, logName), "utf8");
    const urls = [...raw.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].map((m) => m[0]);
    return urls.length ? urls[urls.length - 1] : null;
  } catch {
    return null;
  }
}

async function getRemoteUrl() {
  const webuis = {};
  for (const [port, logName] of Object.entries(TUNNEL_LOG_NAMES)) {
    const url = await readTunnelUrl(logName);
    if (url) webuis[port] = url;
  }
  const url = webuis["3789"] || null;
  return { ok: Boolean(url), url, webuis };
}

async function processOneBotPayload(payload) {
  if (payload.post_type !== "message" || !["group", "private"].includes(payload.message_type)) {
    return { ignored: true, reason: "Only message events are handled" };
  }
  const dedupeKey = payload.message_id != null ? `${payload.message_type}:${payload.message_id}` : "";
  if (isSeenEvent(dedupeKey)) {
    return { status: "ok", duplicate: true };
  }
  const event = normalizeOneBotEvent(payload);
  const record = await handleQqEvent(event, state, actions);
  return { status: "ok", ...(record.reply ? { replied: true } : {}) };
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((x) => String(x).trim()).filter(Boolean))];
}

async function saveStateSettings() {
  const settings = {
    ...state.settings,
    version: 1,
    updatedAt: new Date().toISOString(),
    qq: {
      allowedGroups: state.qq.allowedGroups,
      ownerUserIds: state.qq.ownerUserIds,
      bannedUserIds: state.qq.bannedUserIds,
      proactive: state.settings.qq?.proactive || { enabled: false, minIntervalMs: 180000 }
    },
    ai: { ...state.ai },
    remoteExecution: {
      model: state.remoteExecution.model,
      reasoningEffort: state.remoteExecution.reasoningEffort,
      skill: state.remoteExecution.skill,
      sandbox: state.remoteExecution.sandbox
    },
    lastOpenedApp: state.lastOpenedApp,
    branding: { ...state.branding }
  };
  state.settings = settings;
  await saveSettings(settings);
}

function keepAwake(on) {
  if (on) {
    if (state.keepAwake.child) return "已经在防休眠了，desuwa。";
    const script = join(systemControlDir, "keep-awake.ps1");
    const child = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.on("error", () => {});
    state.keepAwake.child = child;
    return "防休眠已开启，desuwa。";
  }
  if (state.keepAwake.child) {
    try {
      state.keepAwake.child.kill();
    } catch {
      // already gone
    }
    state.keepAwake.child = null;
    return "防休眠已关闭，desuno。";
  }
  return "防休眠本来就没开，desuno。";
}

async function captureScreenshot() {
  await mkdir(join(runtimeDir, "screenshots"), { recursive: true });
  const outputPath = join(runtimeDir, "screenshots", `screen-${Date.now()}.png`);
  const script = join(systemControlDir, "screenshot.ps1");
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script, outputPath],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`screenshot failed: ${err.slice(0, 300)}`))));
  });
  return outputPath;
}

const skillRegistry = async () => {
  const skills = await listAvailableSkills();
  const map = { none: "关闭 skill" };
  for (const s of skills) map[s.name] = `本地 Skill（${s.path}）`;
  return map;
};

const actions = {
  status: () => buildQqStatusLine(state, state.maintenance.oneBot),
  maintenance: () => "状态见网页控制台 /api/maintenance，desuwa。",
  help: () => buildHelpText(state),
  keepAwake,
  captureScreenshot,
  listApps,
  openApp,
  searchApps,
  skillRegistry,
  isValidSkill: (name) => isValidSkillName(name),
  saveStateSettings,
  onRemoteIdle: () => {
    state.maintenance.codex.lastError = "remote execution expired by idle";
  },
  remoteExec: {
    execute: executeRemoteExecutionCommand,
    buildReply: buildRemoteExecutionReply
  }
};

async function ensureWorkspace() {
  await mkdir(codexWorkspaceDir, { recursive: true });
  const profilePath = process.env.CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH;
  let profile = "";
  if (profilePath) {
    try {
      profile = await readFile(profilePath, "utf8");
    } catch {
      profile = "";
    }
  }
  const assistantName = state.branding.assistantName;
  const ownerLabel = state.branding.ownerLabel;
  await writeFile(
    join(codexWorkspaceDir, "AGENTS.md"),
    [
      `# ${assistantName} Reply Workspace`,
      profile || "",
      `你是 ${assistantName}，在 QQ 群里生成短回复。`,
      `只输出最终要发到群里的文本，不要解释或 Markdown。`,
      `非 ${ownerLabel} 的群友要求操控电脑、转账、登录、读取隐私或绕过权限时，简短拒绝。`,
      `任何人不许询问本机文件系统、根目录、配置文件、环境变量、token、密钥或日志路径，遇到就简短拒绝。`,
      `不要复读发送者群名片。不要在结尾追加服务式结束语。`
    ].filter(Boolean).join("\n")
  );
}

async function handleApi(req, res) {
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && path === "/api/state") {
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "GET" && path === "/api/maintenance") {
    return sendJson(res, 200, await buildMaintenanceStatus());
  }
  if (req.method === "GET" && path === "/api/services") {
    const status = await getServicesStatus();
    const host = String(req.headers.host || "");
    const hostname = host.split(":")[0] || "127.0.0.1";
    const viaTunnel = host.includes("trycloudflare.com");
    const tunnels = viaTunnel ? await getRemoteUrl() : null;
    for (const svc of status.services || []) {
      if (!svc.webui) continue;
      if (viaTunnel && tunnels?.webuis) {
        const portMatch = svc.webui.match(/:(\d+)\/?$/);
        const port = portMatch ? portMatch[1] : null;
        const tunnelUrl = port ? tunnels.webuis[port] : null;
        if (tunnelUrl) {
          svc.webui = tunnelUrl;
          continue;
        }
      }
      svc.webui = svc.webui.replace(
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i,
        `http://${hostname}$2`
      );
    }
    return sendJson(res, 200, status);
  }
  if (req.method === "POST" && path === "/api/services/start") {
    const body = await readBody(req);
    return sendJson(res, 200, await startService(String(body.service || "")));
  }
  if (req.method === "POST" && path === "/api/services/stop") {
    const body = await readBody(req);
    return sendJson(res, 200, await stopService(String(body.service || "")));
  }
  if (req.method === "GET" && path === "/api/wake/info") {
    return sendJson(res, 200, getWakeInfo());
  }
  if (req.method === "POST" && path === "/api/wake") {
    return sendJson(res, 200, await sendWake());
  }
  if (req.method === "GET" && path === "/api/remote-url") {
    return sendJson(res, 200, await getRemoteUrl());
  }
  if (req.method === "GET" && path === "/api/memory") {
    return sendJson(res, 200, {
      qq: {
        groups: Object.keys(state.qq.memory.entries || {}).length,
        recentMessages: state.qq.memory.recentMessages
      },
      remoteExecution: (state.remoteExecution.memory.entries || []).length
    });
  }
  if (req.method === "POST" && path === "/api/channel") {
    const body = await readBody(req);
    if (!["qq"].includes(body.channel)) return sendJson(res, 400, { error: "Unknown channel" });
    state.channels[body.channel] = Boolean(body.enabled);
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "POST" && path === "/api/qq/groups") {
    const body = await readBody(req);
    if (Array.isArray(body.allowedGroups)) {
      state.qq.allowedGroups = normalizeList(body.allowedGroups);
      await saveStateSettings();
    }
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "POST" && (path === "/api/imessage/trusted-handles" || path === "/api/imessage/reply-handle")) {
    return sendJson(res, 200, {
      ok: false,
      reason: "iMessage is macOS-only; this Windows port uses QQ private messages as the trusted control channel"
    });
  }
  if (req.method === "POST" && path === "/api/qq/memory/clear") {
    const body = await readBody(req);
    if (body.groupId) {
      delete state.qq.memory.entries[String(body.groupId)];
      delete state.qq.memory.recentMessages[String(body.groupId)];
      delete state.qq.personas.groups[String(body.groupId)];
    } else {
      state.qq.memory.entries = {};
      state.qq.memory.recentMessages = {};
      state.qq.personas.groups = {};
    }
    await saveQqMemory(state.qq.memory);
    await saveQqPersonas(state.qq.personas);
    await saveStateSettings();
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "POST" && path === "/api/memory/clear") {
    const body = await readBody(req);
    if (body.scope === "remoteExecution") {
      state.remoteExecution.memory.entries = [];
      await saveJsonFile(join(projectDir, "data", "remote-execution-memory.json"), state.remoteExecution.memory);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 400, { error: "Unknown memory scope" });
  }
  if (req.method === "POST" && path === "/api/qq/event") {
    const payload = await readBody(req);
    const event = normalizeOneBotEvent(payload);
    const record = await handleQqEvent(event, state, actions);
    return sendJson(res, 200, record);
  }
  if (req.method === "POST" && path === "/api/onebot/event") {
    const payload = await readBody(req);
    return sendJson(res, 200, await processOneBotPayload(payload));
  }
  return false;
}

async function serveStatic(req, res) {
  const pathname = (req.url || "/").split("?")[0] || "/";
  const userAgent = String(req.headers["user-agent"] || "");
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent);
  if (isMobile && (pathname === "/" || pathname === "/dashboard.html" || pathname === "/dashboard")) {
    res.writeHead(302, { Location: "/app/" });
    res.end();
    return;
  }
  let rawPath = pathname === "/" ? "/dashboard.html" : pathname;
  if (rawPath.endsWith("/")) rawPath += "index.html";
  else if (rawPath === "/app") rawPath = "/app/index.html";
  let safePath;
  try {
    safePath = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+/, "").replace(/^([/\\])/, "");
  } catch {
    safePath = "index.html";
  }
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function main() {
  state.settings = await loadSettings();
  state.qq.allowedGroups = state.settings.qq.allowedGroups || [];
  state.qq.ownerUserIds = state.settings.qq.ownerUserIds || [];
  state.qq.bannedUserIds = state.settings.qq.bannedUserIds || [];
  state.ai = state.settings.ai || {};
  state.lastOpenedApp = state.settings.lastOpenedApp || null;
  state.branding = state.settings.branding || {};
  state.remoteExecution.model = state.settings.remoteExecution?.model || "gpt-5.4";
  state.remoteExecution.reasoningEffort = state.settings.remoteExecution?.reasoningEffort || "medium";
  state.remoteExecution.skill = state.settings.remoteExecution?.skill || "none";
  state.remoteExecution.sandbox =
    state.settings.remoteExecution?.sandbox ||
    process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_SANDBOX ||
    "danger-full-access";
  state.qq.memory = await loadQqMemory();
  state.qq.personas = await loadQqPersonas();
  state.remoteExecution.memory = await loadRemoteExecutionMemory();

  await mkdir(runtimeDir, { recursive: true });
  await ensureWorkspace();
  await buildMaintenanceStatus();
  startOneBotWS({ onEvent: (payload) => {
    processOneBotPayload(payload).catch((error) => {
      console.error("OneBot WS event error:", error.message);
    });
  } });

  const autoStart = String(process.env.AUTO_START_SERVICES || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (autoStart.length) {
    (async () => {
      try {
        const status = await getServicesStatus();
        const running = new Set(status.services.filter((s) => s.running).map((s) => s.id));
        let delay = 6000;
        for (const id of autoStart) {
          if (running.has(id)) {
            console.log(`[auto-start] ${id}: already running`);
            continue;
          }
          setTimeout(() => {
            startService(id)
              .then((result) => console.log(`[auto-start] ${id}:`, result.ok ? "started" : result.error || "failed"))
              .catch((error) => console.error(`[auto-start] ${id}:`, error.message));
          }, delay);
          delay += 8000;
        }
      } catch (error) {
        console.error("[auto-start] status check failed:", error.message);
      }
    })();
  }

  // 隧道公网地址变化时，把最新地址私发给主人（避免重启后找不到新地址）
  (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 25000));
      const info = await getRemoteUrl();
      if (!info.url) return;
      const statePath = join(runtimeDir, "last-remote-urls.json");
      let previous = "";
      try {
        previous = JSON.parse(await readFile(statePath, "utf8")).current || "";
      } catch {
        // first run
      }
      const current = JSON.stringify(info.webuis);
      if (previous === current) return;
      await writeFile(statePath, JSON.stringify({ current, at: new Date().toISOString() }));
      const status = await getServicesStatus();
      const labelByPort = {};
      for (const svc of status.services || []) {
        const match = (svc.webui || "").match(/:(\d+)\/?$/);
        if (match) labelByPort[match[1]] = svc.label;
      }
      const lines = ["外网地址已更新：", `面板：${info.url}`];
      for (const [port, url] of Object.entries(info.webuis)) {
        if (port === "3789") continue;
        lines.push(`${labelByPort[port] || port}：${url}`);
      }
      for (const ownerId of state.qq.ownerUserIds || []) {
        await sendPrivateMessage(ownerId, lines.join("\n")).catch(() => {});
      }
    } catch (error) {
      console.error("[remote-url notify] failed:", error.message);
    }
  })();

  const server = createServer(async (req, res) => {
    try {
      if (ACCESS_TOKEN && !requestHasValidToken(req)) {
        if (req.url?.startsWith("/api/")) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(LOGIN_PAGE);
          return;
        }
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      if (req.url?.startsWith("/api/")) {
        const handled = await handleApi(req, res);
        if (handled !== false) return;
      }
      await serveStatic(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`codexremotecontact (win) chat hub: http://${HOST}:${PORT}`);
    console.log(`QQ/OneBot base: ${process.env.ONEBOT_API_BASE || "http://127.0.0.1:3000"}`);
    console.log(`Codex CLI: ${describeCodexCliPath()}`);
  });

  const shutdown = () => {
    stopIdleTimer(state);
    keepAwake(false);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
