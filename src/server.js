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
import { checkOneBotHealth, getOneBotConnectionStatus, startOneBotWS } from "./onebot.js";
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

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(projectDir, "modules", "web-console", "public");
const systemControlDir = join(projectDir, "modules", "system-control");
const runtimeDir = join(projectDir, "runtime");
const PORT = Number(process.env.CODEX_REMOTE_CONTACT_PORT || 3789);
const HOST = process.env.CODEX_REMOTE_CONTACT_HOST || "127.0.0.1";

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
  if (req.method === "GET" && req.url === "/api/state") {
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "GET" && req.url === "/api/maintenance") {
    return sendJson(res, 200, await buildMaintenanceStatus());
  }
  if (req.method === "GET" && req.url === "/api/services") {
    return sendJson(res, 200, await getServicesStatus());
  }
  if (req.method === "POST" && req.url === "/api/services/start") {
    const body = await readBody(req);
    return sendJson(res, 200, await startService(String(body.service || "")));
  }
  if (req.method === "POST" && req.url === "/api/services/stop") {
    const body = await readBody(req);
    return sendJson(res, 200, await stopService(String(body.service || "")));
  }
  if (req.method === "GET" && req.url === "/api/memory") {
    return sendJson(res, 200, {
      qq: {
        groups: Object.keys(state.qq.memory.entries || {}).length,
        recentMessages: state.qq.memory.recentMessages
      },
      remoteExecution: (state.remoteExecution.memory.entries || []).length
    });
  }
  if (req.method === "POST" && req.url === "/api/channel") {
    const body = await readBody(req);
    if (!["qq"].includes(body.channel)) return sendJson(res, 400, { error: "Unknown channel" });
    state.channels[body.channel] = Boolean(body.enabled);
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "POST" && req.url === "/api/qq/groups") {
    const body = await readBody(req);
    if (Array.isArray(body.allowedGroups)) {
      state.qq.allowedGroups = normalizeList(body.allowedGroups);
      await saveStateSettings();
    }
    return sendJson(res, 200, buildPublicState());
  }
  if (req.method === "POST" && (req.url === "/api/imessage/trusted-handles" || req.url === "/api/imessage/reply-handle")) {
    return sendJson(res, 200, {
      ok: false,
      reason: "iMessage is macOS-only; this Windows port uses QQ private messages as the trusted control channel"
    });
  }
  if (req.method === "POST" && req.url === "/api/qq/memory/clear") {
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
  if (req.method === "POST" && req.url === "/api/memory/clear") {
    const body = await readBody(req);
    if (body.scope === "remoteExecution") {
      state.remoteExecution.memory.entries = [];
      await saveJsonFile(join(projectDir, "data", "remote-execution-memory.json"), state.remoteExecution.memory);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 400, { error: "Unknown memory scope" });
  }
  if (req.method === "POST" && req.url === "/api/qq/event") {
    const payload = await readBody(req);
    const event = normalizeOneBotEvent(payload);
    const record = await handleQqEvent(event, state, actions);
    return sendJson(res, 200, record);
  }
  if (req.method === "POST" && req.url === "/api/onebot/event") {
    const payload = await readBody(req);
    return sendJson(res, 200, await processOneBotPayload(payload));
  }
  return false;
}

async function serveStatic(req, res) {
  const rawPath = req.url === "/" ? "/dashboard.html" : req.url.split("?")[0];
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

  const server = createServer(async (req, res) => {
    try {
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
