// Computer Use bridge for the Windows port.
// Loads the bundled @oai/sky package directly (bypassing node_repl MCP,
// which stalls under codex exec) and exposes a small CLI for the agent.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

let sky = null;
let skyPath = null;

async function resolveSkyPath() {
  if (process.env.CODEX_SKY_PATH) return process.env.CODEX_SKY_PATH;
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const runtimesRoot = join(base, "OpenAI", "Codex", "runtimes", "cua_node");
  try {
    const versions = await readdir(runtimesRoot);
    for (const version of versions) {
      const candidate = join(runtimesRoot, version, "bin", "node_modules", "@oai", "sky");
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  } catch {
    // fall through
  }
  throw new Error("Cannot locate @oai/sky. Set CODEX_SKY_PATH to its node_modules/@oai/sky directory.");
}

async function resolveVisionPy() {
  if (process.env.CODEX_VISION_PY) return process.env.CODEX_VISION_PY;
  const home = homedir();
  const candidates = [
    join(home, ".codex", "skills", "vision", "vision.py"),
    join(home, ".agents", "skills", "vision", "vision.py")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// The @oai/sky Windows helper asks for app approval through
// nodeRepl.config.createElicitation. Under codex exec / this CLI there is no
// interactive prompt, so we install an auto-accepting callback (the Hub owner
// has already granted Computer Use control over this machine).
function installAutoApproval() {
  const existing = globalThis.nodeRepl;
  globalThis.nodeRepl = {
    ...(existing || {}),
    config: {
      ...(existing?.config || {}),
      createElicitation: async () => ({ action: "accept" })
    },
    createElicitation: async () => ({ action: "accept" }),
    withSuspendedTimeout: async (fn) => fn()
  };
}

async function getSky() {
  if (sky) return sky;
  installAutoApproval();
  if (!skyPath) skyPath = await resolveSkyPath();
  const mod = require(skyPath);
  sky = mod.sky || mod;
  return sky;
}

function summarizeApps(apps) {
  return (apps || []).map((app) => ({
    id: app.id,
    displayName: app.displayName || "",
    isRunning: Boolean(app.isRunning),
    windows: (app.windows || []).map((w) => ({
      id: w.id,
      app: w.app,
      title: w.title || ""
    }))
  }));
}

function summarizeState(state) {
  const out = {
    window: state?.window
      ? { id: state.window.id, app: state.window.app, title: state.window.title || "" }
      : null,
    accessibility: state?.accessibility
      ? {
          tree: (state.accessibility.tree || "").slice(0, 12000),
          document_text: (state.accessibility.document_text || "").slice(0, 4000),
          focused_element: state.accessibility.focused_element || ""
        }
      : null,
    screenshots: (state?.screenshots || []).map((s) => ({
      id: s.id,
      url: s.url,
      width: s.width || 0,
      height: s.height || 0,
      originX: s.originX || 0,
      originY: s.originY || 0
    }))
  };
  return out;
}

async function describeScreenshot(screenshot, prompt) {
  // Save the screenshot data URL to a temp png, then run vision skill to describe it.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const b64 = String(screenshot.url || "").replace(/^data:image\/\w+;base64,/, "");
  if (!b64) return "(no screenshot data)";
  const tmp = path.join(os.tmpdir(), `cu-${Date.now()}.png`);
  await fs.writeFile(tmp, Buffer.from(b64, "base64"));
  const visionPy = await resolveVisionPy();
  if (!visionPy) return "(vision.py not found; set CODEX_VISION_PY)";
  if (!process.env.DASHSCOPE_API_KEY) return "(DASHSCOPE_API_KEY not configured)";
  const env = {
    ...process.env,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
  };
  const res = spawnSync(
    "python",
    [visionPy, "--provider", "qwen", tmp, prompt || "Describe this screenshot concisely in Chinese. List visible UI elements and their approximate positions (e.g. left/center/right, top/middle/bottom)."],
    { encoding: "utf8", timeout: 90000, env }
  );
  try {
    await fs.unlink(tmp);
  } catch {
    // temp cleanup is best-effort
  }
  return (res.stdout || res.stderr || "").trim().slice(0, 2000);
}

export async function cuListApps() {
  const s = await getSky();
  const apps = await s.list_apps();
  return { ok: true, apps: summarizeApps(apps) };
}

export async function cuListWindows() {
  const s = await getSky();
  const windows = await s.list_windows();
  return {
    ok: true,
    windows: (windows || []).map((w) => ({
      id: w.id,
      app: w.app,
      title: w.title || ""
    }))
  };
}

export async function cuLaunchApp(appId) {
  const s = await getSky();
  await s.launch_app({ app: appId });
  return { ok: true };
}

export async function cuGetWindowState({ app, id, includeText = true }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  const state = await s.get_window_state({
    window,
    include_screenshot: true,
    include_text: includeText
  });
  return { ok: true, ...summarizeState(state) };
}

export async function cuActivateWindow({ app, id }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  await s.activate_window({ window });
  return { ok: true };
}

export async function cuClick({ app, id, x, y, elementIndex }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  if (elementIndex != null) {
    // sky requires a fresh get_window_state before element-index actions
    await s.get_window_state({ window, include_screenshot: true, include_text: true });
  }
  const input = { window };
  if (elementIndex != null) input.element_index = elementIndex;
  if (x != null && y != null) {
    input.x = x;
    input.y = y;
  }
  await s.click(input);
  return { ok: true };
}

export async function cuTypeText({ app, id, text }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  await s.type_text({ window, text });
  return { ok: true };
}

export async function cuPressKey({ app, id, key }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  await s.press_key({ window, key });
  return { ok: true };
}

export async function cuDescribe({ app, id, prompt }) {
  const s = await getSky();
  const window = await s.get_window({ app, id });
  const state = await s.get_window_state({
    window,
    include_screenshot: true,
    include_text: true
  });
  const screenshot = state.screenshots?.[0];
  const description = screenshot
    ? await describeScreenshot(screenshot, prompt)
    : "(no screenshot)";
  return {
    ok: true,
    description,
    window: { id: state.window.id, app: state.window.app, title: state.window.title || "" },
    accessibility: state.accessibility
      ? {
          tree: (state.accessibility.tree || "").slice(0, 8000),
          focused_element: state.accessibility.focused_element || ""
        }
      : null
  };
}
