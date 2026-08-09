// Bootstrap entry: loads local data/hub.env + data/access-token.txt into the
// environment before importing the hub. Keeps launchers free of machine
// specific values. Real environment variables always win over the file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  try {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    console.error(`[load-env] failed to read ${path}:`, error.message);
  }
}

loadEnvFile(join(root, "data", "hub.env"));

if (process.env.CODEX_REMOTE_CONTACT_ACCESS_TOKEN === undefined) {
  try {
    const tokenPath = join(root, "data", "access-token.txt");
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, "utf8").trim();
      if (token) process.env.CODEX_REMOTE_CONTACT_ACCESS_TOKEN = token;
    }
  } catch {
    // token optional
  }
}

await import("./server.js");
