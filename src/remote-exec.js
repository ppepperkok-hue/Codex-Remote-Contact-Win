import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexWorkspaceDir, projectDir, runtimeRepliesDir, saveRemoteExecutionMemory } from "./settings.js";
import { isValidModel, normalizeReasoningEffort, runCodexExec } from "./codex.js";
import { loadSkillContent } from "./skill-loader.js";

const IDLE_TTL_MS = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_IDLE_TTL_MS || 900000);
const MEMORY_LIMIT = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MEMORY_LIMIT || 160);
const DEFAULT_PROFILE_PATH = fileURLToPath(new URL("../data/sakiko-qq-persona.md", import.meta.url));

function compact(command) {
  return String(command || "").replace(/^\/+/, "").replace(/\s+/g, "").toLowerCase();
}

export function touchActivity(state) {
  state.remoteExecution.lastActiveAt = Date.now();
}

export function startIdleTimer(state, onExpire) {
  stopIdleTimer(state);
  state.remoteExecution.idleTimer = setTimeout(() => {
    if (state.remoteExecution.enabled && Date.now() - (state.remoteExecution.lastActiveAt || 0) >= IDLE_TTL_MS) {
      state.remoteExecution.enabled = false;
      state.remoteExecution.idleTimer = null;
      onExpire?.();
    }
  }, IDLE_TTL_MS + 5000);
  state.remoteExecution.idleTimer.unref?.();
}

export function stopIdleTimer(state) {
  if (state.remoteExecution.idleTimer) {
    clearTimeout(state.remoteExecution.idleTimer);
    state.remoteExecution.idleTimer = null;
  }
}

function formatMemory(state) {
  const entries = state.remoteExecution.memory.entries || [];
  if (!entries.length) return "";
  return entries
    .slice(-8)
    .map((e) => `用户：${String(e.user).slice(0, 200)}\n助手：${String(e.reply).slice(0, 150)}`)
    .join("\n\n");
}

async function rememberTurn(state, user, reply) {
  const entries = state.remoteExecution.memory.entries || [];
  entries.push({ user: String(user).slice(0, 2000), reply: String(reply).slice(0, 4000), at: new Date().toISOString() });
  state.remoteExecution.memory.entries = entries.slice(-MEMORY_LIMIT);
  await saveRemoteExecutionMemory(state.remoteExecution.memory);
}

async function buildWorkspaceInstructions(state, profile, memory) {
  const skillContent =
    state.remoteExecution.skill && state.remoteExecution.skill !== "none"
      ? await loadSkillContent(state.remoteExecution.skill)
      : "";
  const computerUseCli = join(projectDir, "tools", "computer-use-cli.mjs").replace(/\\/g, "/");
  const lines = [
    `# ${state.branding.assistantName} Remote Execution Workspace`,
    profile || "",
    "你正在通过 QQ 私聊与电脑的主人对话。你拥有完整工具权限（danger-full-access），可以直接操作本机：打开软件、执行命令、读写文件、查询状态等，就像在本地终端里一样。",
    `自称 ${state.branding.assistantName}，用第一人称「我」。`,
    "回复要适合 QQ 聊天：先说人话结论，再给必要细节；不要用报告式结构，不要堆砌 Markdown。",
    "🚨 QQ 聊天必须短：回复默认控制在 1～3 句、最多 60 字（用户明确要求详细时才例外）。不许分段、不许空行、不许破折号、不许列举。一次说一件事，说完就停。",
    "🚨 禁止客服式收尾：「要不要我帮你」「随时说一声」「如果还需要」这类句子一律禁止，该收就收。",
    "🚨 用户发「嗯」「好」「知道了」这类简短回应时，简单应一声或什么都不用再补充，不要追问、不要解释、不要继续展开。",
    "用户说「打开 xxx」「启动 xxx」「再打开一次」这类话时，直接找到软件并启动，不要只嘴上答应。",
    "用户没说明确指令但提到之前做过的操作时，参考「此前对话记忆」里的上下文继续，不用追问。",
    "操作 Windows 界面（点击、输入、按键、看窗口内容）时，使用本机 Computer Use 工具：",
    `  node "${computerUseCli}" list-apps`,
    "  ... list-windows | launch <app-id> | activate <app> <window-id>",
    "  ... state <app> <window-id>          # 读取窗口 accessibility 树和截图",
    "  ... describe <app> <window-id>       # 截图并请视觉模型描述界面",
    "  ... click <app> <window-id> <x> <y>  # 按坐标点击（窗口相对坐标）",
    "  ... click-index <app> <window-id> <index>  # 按 accessibility 树里的元素索引点击",
    "  ... type <app> <window-id> <text>    # 向当前焦点输入文字",
    "  ... key <app> <window-id> <key>      # 按键：Return/Tab/Escape/Control_L+a 等",
    "操作 GUI 应用优先用 accessibility 树（state/describe 输出）里的元素索引，而不是猜像素坐标。",
    "如果用户要求涉及本机敏感操作（删除文件、改系统设置、转账、登录），先简短说明风险并等待明确确认。",
    memory ? `此前对话记忆：\n${memory}` : null,
    skillContent ? `\n【当前启用的 Skill：${state.remoteExecution.skill}】\n${skillContent}` : null
  ];
  return lines.filter(Boolean).join("\n");
}

export async function executeRemoteExecutionCommand(command, state, actions) {
  const normalized = String(command || "").replace(/^\/+/, "").trim();
  const c = compact(normalized);

  if (/^(远程执行|远程执行模式|开启远程执行|打开远程执行|启动远程执行)$/.test(c)) {
    if (state.remoteExecution.enabled) {
      touchActivity(state);
      return { ok: true, reply: "远程执行模式已经在开着呢，desuwa。" };
    }
    state.remoteExecution.pendingAction = { action: "enable", createdAt: Date.now() };
    return {
      ok: true,
      reply: "准备开启远程执行模式。确认后会启用完整 Codex CLI 通道，并使用独立远程执行记忆。3 分钟内发 /确认 开启，或 /取消。"
    };
  }

  if (/^(确认|确认远程执行|执行远程执行)$/.test(c)) return executePendingAction(state, actions);
  if (/^(取消|取消远程执行)$/.test(c)) {
    state.remoteExecution.pendingAction = null;
    return { ok: true, reply: "已取消，desuwa。" };
  }

  touchActivity(state);

  if (/^(退出远程执行|关闭远程执行|退出远程执行模式|关闭远程执行模式)$/.test(c)) {
    state.remoteExecution.enabled = false;
    state.remoteExecution.pendingAction = null;
    stopIdleTimer(state);
    return { ok: true, reply: "远程执行模式已关闭，desuwa。" };
  }
  if (/^(状态|status)$/.test(c)) {
    return { ok: true, reply: `远程执行模式：开\n模型：${state.remoteExecution.model}\n智能等级：${state.remoteExecution.reasoningEffort}\nskill：${state.remoteExecution.skill}\n沙箱：${state.remoteExecution.sandbox || "read-only"}\n记忆条数：${(state.remoteExecution.memory.entries || []).length}` };
  }
  if (/^(帮助|help)$/.test(c)) {
    return { ok: true, reply: ["远程执行模式指令：", "/退出远程执行 /状态 /清理记忆", "/模型 模型名 /智能等级 low|medium|high", "/沙箱 read-only|workspace-write|danger-full-access", "/skill 列表 /skill none"].join("\n") };
  }
  if (/^(清理记忆|清空记忆|清除记忆)$/.test(c)) {
    state.remoteExecution.memory.entries = [];
    await saveRemoteExecutionMemory(state.remoteExecution.memory);
    return { ok: true, reply: "远程执行记忆已清空，desuwa。" };
  }
  if (/^(skill列表|skilllist|技能列表)$/i.test(c)) {
    const registry = await actions.skillRegistry();
    return { ok: true, reply: `可用 skill：\n${Object.keys(registry).join("\n")}` };
  }
  const skillSet = command.match(/^skill\s+(.+)$/i);
  if (skillSet) {
    const skill = skillSet[1].trim();
    if (!(await actions.isValidSkill(skill))) return { ok: false, reply: "没有这个 skill，发 /skill 列表 看看，desuno。" };
    state.remoteExecution.skill = skill;
    await actions.saveStateSettings();
    return { ok: true, reply: `远程执行 skill 已切换：${skill}` };
  }
  const modelMatch = normalized.match(/^模型\s+(.+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!isValidModel(model)) return { ok: false, reply: "模型名看着不太对，desuno。" };
    state.remoteExecution.model = model;
    await actions.saveStateSettings();
    return { ok: true, reply: `远程执行模型已切换：${model}` };
  }
  const effortMatch = normalized.match(/^智能等级\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (effortMatch) {
    state.remoteExecution.reasoningEffort = normalizeReasoningEffort(effortMatch[1]);
    await actions.saveStateSettings();
    return { ok: true, reply: `远程执行智能等级已切换：${state.remoteExecution.reasoningEffort}` };
  }
  const sandboxMatch = normalized.match(/^沙箱\s+(read-only|workspace-write|danger-full-access)$/i);
  if (sandboxMatch) {
    state.remoteExecution.sandbox = sandboxMatch[1].toLowerCase();
    await actions.saveStateSettings();
    return { ok: true, reply: `远程执行沙箱已切换：${state.remoteExecution.sandbox}。该级别决定 Codex 能否真正改文件和执行命令，desuwa。` };
  }
  return { ok: true, mode: "reply", text: normalized };
}

async function executePendingAction(state, actions) {
  const pending = state.remoteExecution.pendingAction;
  if (!pending) return { ok: false, reply: "当前没有待确认的操作，desuno。" };
  if (Date.now() - pending.createdAt > 3 * 60 * 1000) {
    state.remoteExecution.pendingAction = null;
    return { ok: false, reply: "确认超时了，请重新发起，desuno。" };
  }
  state.remoteExecution.pendingAction = null;
  if (pending.action === "enable") {
    state.remoteExecution.enabled = true;
    state.remoteExecution.lastActiveAt = Date.now();
    startIdleTimer(state, () => actions.onRemoteIdle?.());
    return { ok: true, reply: "远程执行模式已开启。直接发任务给我就行，desuwa。" };
  }
  return { ok: false, reply: "未知的待确认操作，desuno。" };
}

export async function buildRemoteExecutionReply(userText, state, actions) {
  touchActivity(state);
  const memory = formatMemory(state);
  const profilePath = process.env.CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH || DEFAULT_PROFILE_PATH;
  let profile = "";
  if (profilePath) {
    try {
      const { readFile } = await import("node:fs/promises");
      profile = await readFile(profilePath, "utf8");
    } catch {
      profile = "";
    }
  }
  const instructions = await buildWorkspaceInstructions(state, profile, memory);
  await mkdir(codexWorkspaceDir, { recursive: true });
  await mkdir(runtimeRepliesDir, { recursive: true });
  await writeFile(join(codexWorkspaceDir, "AGENTS.md"), instructions, "utf8");
  const outputPath = join(runtimeRepliesDir, `remote-${Date.now()}.txt`);
  const result = await runCodexExec({
    model: state.remoteExecution.model,
    reasoningEffort: state.remoteExecution.reasoningEffort,
    workspace: codexWorkspaceDir,
    prompt: userText,
    outputPath,
    timeout: 300000,
    sandbox: state.remoteExecution.sandbox || process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_SANDBOX || "read-only",
    env: { CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MODE: "1" }
  });
  const reply = result.output || result.stdout || "执行完了，但没有拿到输出，desuno。";
  await rememberTurn(state, userText, reply.slice(0, 4000));
  return reply.slice(0, 1600);
}
