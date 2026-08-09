// Scan local skill directories and load SKILL.md content for the agent.
import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveSkillRoots() {
  if (process.env.CODEX_SKILL_ROOTS) {
    return process.env.CODEX_SKILL_ROOTS
      .split(";")
      .map((root) => root.trim())
      .filter(Boolean);
  }
  const home = homedir();
  return [join(home, ".codex", "skills"), join(home, ".agents", "skills")];
}

const SKILL_ROOTS = resolveSkillRoots();

const EXCLUDED = new Set([
  ".system",
  ".tmp",
  "bili_summary_work",
  "sakiko", // handled by persona profile; still listed below as selectable
]);

let cache = null;

function stripFrontmatter(raw) {
  const text = String(raw || "");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) return text.slice(end + 4).trim();
  }
  return text.trim();
}

async function scanRoot(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED.has(entry.name)) continue;
    const skillDir = join(root, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    try {
      await access(skillFile);
      const raw = await readFile(skillFile, "utf8");
      out.push({
        name: entry.name,
        path: skillFile,
        content: stripFrontmatter(raw).slice(0, 16000)
      });
    } catch {
      // no SKILL.md; skip
    }
  }
  return out;
}

export async function listAvailableSkills() {
  if (cache) return cache;
  const all = [];
  for (const root of SKILL_ROOTS) {
    all.push(...(await scanRoot(root)));
  }
  const seen = new Map();
  for (const skill of all) {
    if (!seen.has(skill.name)) seen.set(skill.name, skill);
  }
  cache = [...seen.values()];
  return cache;
}

export async function loadSkillContent(name) {
  if (!name || name === "none") return "";
  const skills = await listAvailableSkills();
  const found = skills.find((s) => s.name === name);
  if (!found) return "";
  try {
    return await readFile(found.path, "utf8");
  } catch {
    return found.content || "";
  }
}

export async function isValidSkillName(name) {
  if (name === "none") return true;
  const skills = await listAvailableSkills();
  return skills.some((s) => s.name === name);
}
