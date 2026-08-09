import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const projectDir = join(__dirname, "..");
export const dataDir = join(projectDir, "data");
export const settingsPath = join(dataDir, "settings.json");
export const qqMemoryPath = join(dataDir, "qq-memory.json");
export const remoteExecutionMemoryPath = join(dataDir, "remote-execution-memory.json");
export const codexWorkspaceDir = join(projectDir, "workspaces", "codex-cli");
export const runtimeRepliesDir = join(projectDir, "runtime", "replies");

export const defaultSettings = {
  version: 1,
  updatedAt: null,
  qq: {
    allowedGroups: [],
    ownerUserIds: [],
    bannedUserIds: [],
    proactive: {
      enabled: false,
      minIntervalMs: 180000
    }
  },
  ai: {
    model: "auto",
    reasoningEffort: "medium"
  },
  remoteExecution: {
    model: "auto",
    reasoningEffort: "medium",
    skill: "none"
  },
  lastOpenedApp: null,
  branding: {
    assistantName: "assistant",
    ownerLabel: "owner",
    assistantMentions: ["@assistant"]
  }
};

export async function loadJsonFile(path, fallback) {
  try {
    await access(path);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export async function saveJsonFile(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

export async function loadSettings() {
  return loadJsonFile(settingsPath, defaultSettings);
}

export async function saveSettings(settings) {
  settings.updatedAt = new Date().toISOString();
  await saveJsonFile(settingsPath, settings);
}

export async function loadQqMemory() {
  return loadJsonFile(qqMemoryPath, { entries: {}, recentMessages: {} });
}

export async function saveQqMemory(memory) {
  await saveJsonFile(qqMemoryPath, memory);
}

export async function loadRemoteExecutionMemory() {
  return loadJsonFile(remoteExecutionMemoryPath, { entries: [] });
}

export async function saveRemoteExecutionMemory(memory) {
  await saveJsonFile(remoteExecutionMemoryPath, memory);
}
