import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function isWindows() {
  return process.platform === "win32";
}

async function findCodexDesktopCli() {
  if (!isWindows()) return null;
  const appsDir = join("C:", "Program Files", "WindowsApps");
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(appsDir);
    const candidates = entries
      .filter((name) => /^OpenAI\.Codex_/i.test(name) && /_x64__/.test(name))
      .map((name) => join(appsDir, name, "app", "resources", "codex.exe"));
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  } catch {
    // WindowsApps not readable; fall through
  }
  return null;
}

let resolvedCliPath = null;
let resolvedSpawnSpec = null;

async function resolveNpmCodexJs() {
  if (!isWindows()) return null;
  const candidate = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export async function resolveCodexSpawn() {
  if (resolvedSpawnSpec) return resolvedSpawnSpec;
  const fromEnv = process.env.CODEX_CLI_PATH;
  if (fromEnv) {
    try {
      await access(fromEnv);
      resolvedSpawnSpec = { file: fromEnv, prefix: [] };
      return resolvedSpawnSpec;
    } catch {
      // fall through
    }
  }
  const npmJs = await resolveNpmCodexJs();
  if (npmJs) {
    resolvedSpawnSpec = { file: process.execPath, prefix: [npmJs] };
    return resolvedSpawnSpec;
  }
  const desktopCli = await findCodexDesktopCli();
  if (desktopCli) {
    resolvedSpawnSpec = { file: desktopCli, prefix: [] };
    return resolvedSpawnSpec;
  }
  resolvedSpawnSpec = { file: "codex", prefix: [] };
  return resolvedSpawnSpec;
}

export async function resolveCodexCliPath() {
  if (resolvedCliPath) return resolvedCliPath;
  const fromEnv = process.env.CODEX_CLI_PATH;
  if (fromEnv) {
    try {
      await access(fromEnv);
      resolvedCliPath = fromEnv;
      return resolvedCliPath;
    } catch {
      // fall through
    }
  }
  const desktopCli = await findCodexDesktopCli();
  if (desktopCli) {
    resolvedCliPath = desktopCli;
    return resolvedCliPath;
  }
  resolvedCliPath = "codex"; // rely on PATH (e.g. npm i -g @openai/codex)
  return resolvedCliPath;
}

export async function checkCodexCliStatus() {
  const fromEnv = process.env.CODEX_CLI_PATH;
  if (fromEnv) {
    try {
      await access(fromEnv);
      return { pathExists: true, cli: fromEnv };
    } catch {
      // fall through
    }
  }
  const npmJs = await resolveNpmCodexJs();
  if (npmJs) {
    return { pathExists: true, cli: "npm global @openai/codex (node)" };
  }
  const desktopCli = await findCodexDesktopCli();
  if (desktopCli) {
    return { pathExists: true, cli: desktopCli };
  }
  try {
    const lookup = spawnSync(isWindows() ? "where.exe" : "which", ["codex"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
    if (lookup.status === 0 && lookup.stdout && lookup.stdout.trim()) {
      return { pathExists: true, cli: lookup.stdout.trim().split(/\r?\n/)[0] };
    }
  } catch {
    // fall through
  }
  return { pathExists: false, cli: "codex (PATH)" };
}

export function isValidModel(value) {
  return /^[A-Za-z0-9._:\/-]+$/.test(String(value || "").trim());
}

export function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
  if (normalized === "低") return "low";
  if (normalized === "中") return "medium";
  if (normalized === "高") return "high";
  if (normalized === "最高") return "xhigh";
  return "medium";
}

export function runCodexCli(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Codex CLI timed out"));
    }, options.timeout || 120000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Codex CLI exited with ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      }
    });
    child.stdin.end(input);
  });
}

export async function runCodexExec({ model, reasoningEffort, workspace, prompt, outputPath, timeout, env, sandbox = "read-only" }) {
  const spec = await resolveCodexSpawn();
  const args = [
    ...spec.prefix,
    "exec",
    "--skip-git-repo-check",
    "-s",
    sandbox,
  ];
  if (model && model !== "auto") args.push("-m", model);
  if (reasoningEffort && reasoningEffort !== "auto") args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-C", workspace, "-o", outputPath, "-");
  const result = await runCodexCli(spec.file, args, prompt, {
    cwd: workspace,
    timeout: timeout || 120000,
    env
  });
  try {
    const output = await readFile(outputPath, "utf8");
    return { ...result, output: output.trim() };
  } catch {
    return { ...result, output: "" };
  }
}

export function describeCodexCliPath() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (resolvedSpawnSpec?.prefix?.length) return "npm global @openai/codex (node)";
  return resolvedSpawnSpec?.file || "codex (PATH)";
}
