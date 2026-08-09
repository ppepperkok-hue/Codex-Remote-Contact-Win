// Service registry + control for the Windows port dashboard.
// Knows how to probe NapCat / AstrBot / the hub itself, start them
// hidden (VBS, no cmd black window) and stop them by port / process.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./settings.js";

const DEFAULT_SERVICES = {
  astrbot: {
    id: "astrbot",
    label: "AstrBot",
    role: "QQ 机器人框架",
    webui: "http://127.0.0.1:6185",
    httpPorts: [6185, 6199],
    vbs: "C:\\path\\to\\AstrBotLauncher\\start-astrbot-hidden.vbs",
    stopByPort: 6185,
    stopHint: "停止后 QQ 对话将不再自动回复"
  },
  "napcat-10001": {
    id: "napcat-10001",
    label: "NapCat 示例账号",
    role: "QQ 10001 · NapCat",
    qq: "10001",
    webui: "http://127.0.0.1:6099",
    httpPorts: [6099],
    wsPorts: [3001],
    vbs: "C:\\path\\to\\NapCat.Shell\\start-napcat-10001-hidden.vbs",
    stopByProcess: { name: "NapCatWinBootMain.exe", match: "10001" },
    stopHint: "会断开该 QQ 的登录，再次启动会快速登录，无需重新扫码"
  },
  hub: {
    id: "hub",
    label: "Codex Remote Hub",
    role: "本管理面板",
    webui: "http://127.0.0.1:3789",
    httpPorts: [3789],
    self: true
  }
};

function loadServicesConfig() {
  const configPath = join(projectDir, "data", "services.json");
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length) {
        return parsed;
      }
    }
  } catch (error) {
    console.error(`Failed to load ${configPath}, using built-in defaults:`, error.message);
  }
  return DEFAULT_SERVICES;
}

const SERVICES = loadServicesConfig();

function probeHttp(port) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    fetch(`http://127.0.0.1:${port}`, {
      signal: controller.signal,
      redirect: "manual"
    })
      .then((res) => resolve({ up: true, status: res.status }))
      .catch(() => resolve({ up: false }))
      .finally(() => clearTimeout(timer));
  });
}

function probeTcp(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ up: false });
    }, 1200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ up: true });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ up: false });
    });
  });
}

export async function getServicesStatus() {
  const services = [];
  for (const svc of Object.values(SERVICES)) {
    const http = await Promise.all((svc.httpPorts || []).map(probeHttp));
    const ws = await Promise.all((svc.wsPorts || []).map(probeTcp));
    const running = http.some((r) => r.up) || ws.some((r) => r.up);
    services.push({
      id: svc.id,
      label: svc.label,
      role: svc.role,
      qq: svc.qq,
      webui: svc.webui,
      running,
      self: Boolean(svc.self),
      startable: Boolean(svc.vbs),
      stoppable: Boolean(svc.stopByPort || svc.stopByProcess),
      stopHint: svc.stopHint || "",
      http: (svc.httpPorts || []).map((port, i) => ({ port, ...http[i] })),
      ws: (svc.wsPorts || []).map((port, i) => ({ port, ...ws[i] }))
    });
  }
  return { services, checkedAt: new Date().toISOString() };
}

function runPowershell(script) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}

export async function startService(id) {
  const svc = SERVICES[id];
  if (!svc || !svc.vbs) return { ok: false, error: "unknown or not startable service" };
  return new Promise((resolve) => {
    const child = spawn("wscript.exe", [svc.vbs], { windowsHide: true, stdio: "ignore" });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `wscript exited ${code}` });
    });
  });
}

export async function stopService(id) {
  const svc = SERVICES[id];
  if (!svc || svc.self) return { ok: false, error: "cannot stop this service" };
  if (svc.stopByPort) {
    const script = [
      `$p = (Get-NetTCPConnection -LocalPort ${svc.stopByPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      `if ($p) { taskkill /PID $p /T /F | Out-Null; Write-Output "stopped:$p" } else { Write-Output "not-running" }`
    ].join("; ");
    return runPowershell(script);
  }
  if (svc.stopByProcess) {
    const { name, match } = svc.stopByProcess;
    const script = [
      `$procs = Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -match '${match}' }`,
      `foreach ($proc in $procs) { taskkill /PID $proc.ProcessId /T /F | Out-Null; Write-Output "stopped:$($proc.ProcessId)" }`,
      `if (-not $procs) { Write-Output "not-running" }`
    ].join("; ");
    return runPowershell(script);
  }
  return { ok: false, error: "no stop strategy" };
}
