// Local app launcher for the Windows port.
// Enumerates Start Menu apps (Get-StartApps) with an on-disk cache,
// then launches a matched app via PowerShell Start-Process / explorer.
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./settings.js";

const appsCachePath = join(dataDir, "apps-cache.json");
const CACHE_TTL_MS = Number(process.env.CODEX_REMOTE_CONTACT_APPS_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const EXTRA_APPS = [
  { name: "微信", appId: "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe" },
  { name: "WeChat", appId: "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe" },
  { name: "QQ", appId: "C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe" },
  { name: "QQNT", appId: "C:\\Program Files\\Tencent\\QQNT\\QQ.exe" },
  { name: "任务管理器", appId: "taskmgr.exe" },
  { name: "控制面板", appId: "control.exe" },
  { name: "文件资源管理器", appId: "explorer.exe" },
  { name: "设置", appId: "ms-settings:" }
];

let cache = null;

function normalize(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

async function fetchStartApps() {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

async function loadCache() {
  try {
    await access(appsCachePath);
    const raw = await readFile(appsCachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.apps) && Date.now() - (parsed.fetchedAt || 0) < CACHE_TTL_MS) {
      return parsed.apps.map((a) => ({ name: a.Name ?? a.name ?? "", appId: a.AppID ?? a.appId ?? "" }));
    }
  } catch {
    // cache missing or stale; refresh below
  }
  const fresh = await fetchStartApps();
  const normalized = fresh.map((a) => ({ name: a.Name ?? a.name ?? "", appId: a.AppID ?? a.appId ?? "" }));
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(appsCachePath, JSON.stringify({ fetchedAt: Date.now(), apps: normalized }, null, 2), "utf8");
  } catch {
    // cache write is best-effort
  }
  return normalized;
}

export async function listApps() {
  if (!cache) cache = await loadCache();
  return [...EXTRA_APPS, ...cache];
}

export async function findApp(query) {
  const q = normalize(query);
  if (!q) return null;
  const apps = await listApps();
  const exact = apps.find((a) => normalize(a.name) === q);
  if (exact) return exact;
  const contains = apps.filter((a) => normalize(a.name).includes(q));
  if (contains.length === 1) return contains[0];
  return contains.length > 1 ? { multiple: contains.slice(0, 8) } : null;
}

function launchCommandFor(app) {
  const target = String(app.appId || "").trim();
  if (!target) return null;
  // Local executable path
  if (/\.(exe|bat|cmd|lnk)$/i.test(target) || target.includes(":\\")) {
    return `Start-Process -FilePath '${target.replace(/'/g, "''")}'`;
  }
  // Protocol / web URL (steam://, https://, ms-settings:)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    return `Start-Process '${target.replace(/'/g, "''")}'`;
  }
  // UWP / shell app id (Chrome, MSEdge, Microsoft.*, com.*)
  return `Start-Process 'shell:AppsFolder\\${target.replace(/'/g, "''")}'`;
}

export async function launchApp(app) {
  const command = launchCommandFor(app);
  if (!command) return { ok: false, error: "no launch target" };
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
    );
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: (err || `exit ${code}`).slice(0, 300) });
    });
  });
}

export async function openApp(query) {
  const found = await findApp(query);
  if (!found) {
    return {
      ok: false,
      reply: `没找到叫「${query}」的应用。发 /软件列表 关键词 让我找找，desuwa。`
    };
  }
  if (found.multiple) {
    return {
      ok: false,
      reply: `「${query}」匹配到好几个，说具体点：${found.multiple.map((a) => a.name).join("、")}，desuno。`
    };
  }
  const result = await launchApp(found);
  if (!result.ok) {
    return { ok: false, reply: `启动「${found.name}」失败了：${result.error}，desuno。` };
  }
  return { ok: true, name: found.name, reply: `已启动「${found.name}」，desuwa。` };
}

export async function searchApps(query) {
  const q = normalize(query);
  const apps = await listApps();
  if (!q) return apps.slice(0, 30);
  return apps.filter((a) => normalize(a.name).includes(q)).slice(0, 30);
}
