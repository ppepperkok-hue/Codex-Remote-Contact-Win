import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexWorkspaceDir,
  saveQqMemory,
  runtimeRepliesDir
} from "./settings.js";
import { isValidModel, normalizeReasoningEffort, runCodexExec } from "./codex.js";
import { sendGroupMessage, sendPrivateImages, sendPrivateMessage } from "./onebot.js";

const QQ_REPLY_MAX = 900;

function segmentsToText(segments) {
  if (typeof segments === "string") return segments;
  if (!Array.isArray(segments)) return "";
  return segments
    .map((seg) => {
      if (seg.type === "text") return seg.data?.text || "";
      if (seg.type === "at") return `@${seg.data?.qq || seg.data?.name || "someone"}`;
      if (seg.type === "image") return "[图片]";
      if (seg.type === "face") return "[表情]";
      if (seg.type === "record" || seg.type === "voice") return "[语音]";
      return `[${seg.type}]`;
    })
    .join("");
}

export function normalizeOneBotEvent(payload) {
  const segments = payload.message || [];
  const text = segmentsToText(segments);
  const selfId = payload.self_id != null ? String(payload.self_id) : "";
  const userId = payload.user_id != null ? String(payload.user_id) : "";
  const groupId = payload.group_id != null ? String(payload.group_id) : "";
  return {
    raw: payload,
    type: payload.message_type === "private" ? "private_message" : "group_message",
    groupId,
    userId,
    userName: payload.sender?.card || payload.sender?.nickname || "",
    selfId,
    text,
    segments,
    messageId: payload.message_id,
    time: payload.time,
    hasAt: payload.message_type === "group" && segments.some((seg) => seg.type === "at"),
    hasImage: segments.some((seg) => seg.type === "image")
  };
}

function isBanned(event, state) {
  return state.qq.bannedUserIds.includes(event.userId);
}

function isOwner(event, state) {
  return event.userId != null && state.qq.ownerUserIds.includes(event.userId);
}

function mentionsAssistant(event, state) {
  if (event.hasAt) return true;
  const mentions = state.branding.assistantMentions || ["@assistant"];
  return mentions.some((m) => event.text.includes(m));
}

export function shouldRespond(event, state) {
  if (!state.channels.qq) return { ok: false, reason: "QQ channel is off" };
  if (isBanned(event, state)) return { ok: false, reason: "Sender is banned" };
  if (event.type === "private_message") return { ok: true };
  if (event.groupId && !state.qq.allowedGroups.includes(event.groupId)) {
    return { ok: false, reason: "Group is not allowed" };
  }
  if (!mentionsAssistant(event, state)) {
    return { ok: false, reason: "Not mentioned" };
  }
  return { ok: true };
}

function stripMentionText(text, state) {
  const mentions = state.branding.assistantMentions || ["@assistant"];
  let cleaned = text.replace(/@\S+/g, " ").trim();
  for (const m of mentions) {
    cleaned = cleaned.replace(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ").trim();
  }
  return cleaned;
}

function compact(command) {
  return String(command || "").replace(/^\/+/, "").replace(/\s+/g, "").toLowerCase();
}

function extractTargetId(event, normalized) {
  const at = (event.segments || []).find((seg) => seg.type === "at" && seg.data?.qq && seg.data.qq !== "all");
  if (at) return String(at.data.qq);
  const match = String(normalized || "").match(/\d{5,}/);
  return match ? match[0] : "";
}

function pickAck() {
  const acks = [
    "嗯，交给我，稍等 desuwa。",
    "好，我看看 desuno。",
    "明白，这就去办，稍等片刻 teyo。",
    "嗯，知道了，让我处理一下 desuwa。",
    "好，交给我吧，desuwa。"
  ];
  return acks[Math.floor(Math.random() * acks.length)];
}

function shouldAck(text) {
  // 只有任务型消息才提前回应；纯闲聊直接等结果，不打断。
  return /(打开|启动|运行|开启|关闭|停止|清理|清空|删除|下载|安装|搜索|查找|查询|查看|检查|检测|修复|设置|配置|操作|点击|执行|处理|分析|对比|总结|翻译|整理|放歌|播放|截图|截屏|写|做个|帮我|弄一下|搞定|优化|更新|备份|压缩|解压|上传|发送)/i.test(
    String(text || "")
  );
}

function pickTaskAck(text) {
  const t = String(text || "");
  if (/(打开|启动|运行|开启)/i.test(t)) {
    return ["好，我去找一下，稍等 desuwa。", "嗯，这就去开，等等 teyo。"][Math.floor(Math.random() * 2)];
  }
  if (/(清理|清空|删除|卸载|优化|压缩)/i.test(t)) {
    return ["好，交给我，我小心点来 desuwa。", "嗯，我来处理，放心 desuno。"][Math.floor(Math.random() * 2)];
  }
  if (/(查|看|检查|检测|分析|对比|总结|搜索|找)/i.test(t)) {
    return ["好，我看看 desuno。", "嗯，让我查一下 desuwa。"][Math.floor(Math.random() * 2)];
  }
  if (/(写|做个|创建|生成|翻译|整理)/i.test(t)) {
    return ["好，我来弄，稍等 teyo。", "嗯，交给我写，desuwa。"][Math.floor(Math.random() * 2)];
  }
  return pickAck();
}

function buildBoundaryReply(event, state) {
  const text = stripMentionText(event.text, state);
  if (/(根目录|C盘|D盘|文件系统|环境变量|token|密钥|密码)/i.test(text) && !isOwner(event, state)) {
    return "这个我没法在群里说，涉及本机文件和后端信息，desuwa。";
  }
  return null;
}

export async function buildQqCommandAction(event, state, actions) {
  const text = stripMentionText(event.text, state);
  const owner = isOwner(event, state);
  if (owner && event.type === "private_message") {
    // 「再打开一次 / 重新打开 / 再启动」→ 打开上次启动的软件
    const reopen = text.match(/^(?:再|重新|再来)(?:打开|启动|运行|开启)(?:一次|一下|一遍|回)?$/i);
    if (reopen) {
      if (state.lastOpenedApp) {
        const result = await actions.openApp(state.lastOpenedApp);
        return { reply: result.reply || `启动失败：${result.error || "未知错误"}，desuno。` };
      }
      return null; // 没有快路径记忆，交给完整 Codex 从对话记忆里找
    }
    const naturalOpen = text.match(/^(?:打开|启动)\s*(.+)$/i);
    if (naturalOpen) {
      const result = await actions.openApp(naturalOpen[1].trim());
      if (result.ok && result.name) {
        state.lastOpenedApp = result.name;
        await actions.saveStateSettings();
        return { reply: result.reply };
      }
      return null; // 快路径找不到，交给完整 Codex 自己找软件启动
    }
    // 宽松匹配：句子中包含「打开/启动」且包含某个已装软件名时直接启动
    if (/(打开|启动|运行|开启)/.test(text)) {
      const apps = await actions.listApps();
      const matched = apps.find((a) => a.name && text.includes(a.name));
      if (matched) {
        const result = await actions.openApp(matched.name);
        if (result.ok && result.name) {
          state.lastOpenedApp = result.name;
          await actions.saveStateSettings();
          return { reply: result.reply };
        }
        return null; // 启动失败，交给 Codex 兜底
      }
      return null; // 提到打开但没匹配到软件名 → 交给完整 Codex 处理
    }
  }
  if (!text.startsWith("/")) return null;
  const normalized = text.replace(/^\/+/, "").trim();
  const c = compact(normalized);

  if (!owner) {
    if (/^(ban|unban|关闭qq|关掉qq|停止qq|白名单|加群|删群|清理记忆|清空记忆|开启qq|开启QQ)/i.test(c)) {
      return { reply: `这个是指令操作，只听 ${state.branding.ownerLabel} 的，desuwa。` };
    }
    return null;
  }

  if (/^(状态|status)$/i.test(c)) return { reply: actions.status() };
  if (/^(维护|maintenance)$/i.test(c)) return { reply: actions.maintenance() };
  if (/^(开启qq|打开qq)$/i.test(c)) {
    state.channels.qq = true;
    return { reply: "QQ 通道已开启，desuwa。", afterSend: () => actions.saveStateSettings() };
  }
  if (/^(关闭qq|关掉qq|停止qq)$/i.test(c)) {
    state.channels.qq = false;
    return { reply: "QQ 通道已关闭。想再打开的话，从网页控制台或这里说一声就行，desuwa。", afterSend: () => actions.saveStateSettings() };
  }
  if (/^(白名单|群列表)$/i.test(c)) {
    const list = state.qq.allowedGroups.length ? state.qq.allowedGroups.join("\n") : "（空）";
    return { reply: `当前白名单群：\n${list}` };
  }
  const addGroup = normalized.match(/^(?:加群|加入群)\s+(\d+)$/i);
  if (addGroup) {
    const gid = addGroup[1];
    if (!state.qq.allowedGroups.includes(gid)) state.qq.allowedGroups.push(gid);
    return { reply: `已加入白名单：${gid}，desuwa。`, afterSend: () => actions.saveStateSettings() };
  }
  const delGroup = normalized.match(/^(?:删群|移出群)\s+(\d+)$/i);
  if (delGroup) {
    state.qq.allowedGroups = state.qq.allowedGroups.filter((g) => g !== delGroup[1]);
    return { reply: `已移出白名单：${delGroup[1]}。`, afterSend: () => actions.saveStateSettings() };
  }
  if (/^(ban|封禁|拉黑)/i.test(normalized)) {
    const targetId = extractTargetId(event, normalized);
    if (!targetId) return { reply: "要封谁呢？可以用 /ban @对方 或 /ban QQ号，desuwa。" };
    if (state.qq.ownerUserIds.includes(targetId)) return { reply: "Owner 不能 ban，权限核心不能拔掉，desuno。" };
    if (event.selfId === targetId) return { reply: "不能把自己 ban 掉，不然接口当场打结，desuno。" };
    if (!state.qq.bannedUserIds.includes(targetId)) state.qq.bannedUserIds.push(targetId);
    return { reply: `已加入 ban 名单：${targetId}。`, afterSend: () => actions.saveStateSettings() };
  }
  if (/^(unban|解禁|解除封禁|取消拉黑)/i.test(normalized)) {
    const targetId = extractTargetId(event, normalized);
    if (!targetId) return { reply: "要解封谁呢，desuwa？" };
    state.qq.bannedUserIds = state.qq.bannedUserIds.filter((id) => id !== targetId);
    return { reply: `已解封：${targetId}。`, afterSend: () => actions.saveStateSettings() };
  }
  if (/^(banlist|封禁列表)$/i.test(c)) {
    return { reply: state.qq.bannedUserIds.length ? `当前 ban 名单：\n${state.qq.bannedUserIds.join("\n")}` : "暂无 ban 用户。" };
  }
  const modelMatch = normalized.match(/^模型\s+(.+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!isValidModel(model)) return { reply: "这个模型名看着不太对，只接受字母、数字、点、横线、下划线和冒号，desuno。" };
    state.ai.model = model;
    return { reply: `QQ 通道模型已切换：${model}`, afterSend: () => actions.saveStateSettings() };
  }
  const effortMatch = normalized.match(/^智能等级\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (effortMatch) {
    state.ai.reasoningEffort = normalizeReasoningEffort(effortMatch[1]);
    return { reply: `QQ 通道智能等级已切换：${state.ai.reasoningEffort}`, afterSend: () => actions.saveStateSettings() };
  }
  if (/^(清理记忆|清空记忆|清除记忆)$/i.test(c)) {
    state.qq.memory.entries = {};
    state.qq.memory.recentMessages = {};
    return {
      reply: "QQ 记忆已清空，desuwa。",
      afterSend: async () => {
        await saveQqMemory(state.qq.memory);
      }
    };
  }
  if (/^(防休眠|保持唤醒)$/i.test(c)) {
    return { reply: "收到，我来让这台机器醒着，desuwa。", afterSend: () => actions.keepAwake(true) };
  }
  if (/^(恢复休眠|取消防休眠|停止防休眠)$/i.test(c)) {
    return { reply: "好，不再强制唤醒了，desuno。", afterSend: () => actions.keepAwake(false) };
  }
  if (/^(截图|截屏|截个图|屏幕截图)$/i.test(c)) {
    return {
      reply: "截好了，图这就发给你，desuwa。",
      images: async () => {
        try {
          const outputPath = await actions.captureScreenshot();
          return [outputPath];
        } catch (error) {
          return { error: error.message };
        }
      }
    };
  }
  const openMatch = normalized.match(/^(?:打开|启动|运行|开启)\s*(.+)$/i);
  if (openMatch) {
    const result = await actions.openApp(openMatch[1].trim());
    if (result.ok && result.name) {
      state.lastOpenedApp = result.name;
      return { reply: result.reply, afterSend: () => actions.saveStateSettings() };
    }
    return { reply: result.reply || `启动失败：${result.error || "未知错误"}，desuno。` };
  }
  const listMatch = normalized.match(/^(?:软件列表|列出软件|查软件)\s*(.*)$/i);
  if (listMatch) {
    const query = listMatch[1].trim();
    const apps = await actions.searchApps(query);
    if (!apps.length) return { reply: "没找到匹配的软件，desuno。" };
    const names = apps.map((a) => a.name).join("\n");
    return {
      reply: `找到这些软件：\n${names}${apps.length === 30 ? "\n（可能还有更多，换个关键词试试）" : ""}`
    };
  }
  if (/^(帮助|help|指令)$/i.test(c)) {
    return { reply: actions.help() };
  }
  return null;
}

function rememberGroupMessage(event, state) {
  if (!event.groupId) return;
  const list = state.qq.memory.recentMessages[event.groupId] || [];
  list.push({
    time: event.time || Math.floor(Date.now() / 1000),
    userId: event.userId,
    userName: event.userName,
    text: String(event.text || "").slice(0, 300)
  });
  state.qq.memory.recentMessages[event.groupId] = list.slice(-30);
  const entry = state.qq.memory.entries[event.groupId] || { exchanges: [] };
  entry.exchanges.push(`${event.userName || event.userId}: ${String(event.text || "").slice(0, 200)}`);
  entry.exchanges = entry.exchanges.slice(-12);
  state.qq.memory.entries[event.groupId] = entry;
}

function rememberExchange(event, reply, state) {
  if (!event.groupId) return;
  const entry = state.qq.memory.entries[event.groupId] || { exchanges: [] };
  entry.exchanges.push(`${state.branding.assistantName}: ${String(reply || "").slice(0, 200)}`);
  entry.exchanges = entry.exchanges.slice(-12);
  state.qq.memory.entries[event.groupId] = entry;
}

function formatMemoryContext(event, state) {
  const recent = (state.qq.memory.recentMessages[event.groupId] || []).slice(-12);
  if (!recent.length) return "";
  return recent
    .map((m) => `${m.userName || m.userId}: ${m.text}`)
    .join("\n");
}

async function buildWorkspaceInstructions(state, extra) {
  const assistantName = state.branding.assistantName;
  const ownerLabel = state.branding.ownerLabel;
  const profilePath =
    process.env.CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH ||
    fileURLToPath(new URL("../data/sakiko-qq-persona.md", import.meta.url));
  let profile = "";
  if (profilePath) {
    try {
      const { readFile } = await import("node:fs/promises");
      profile = await readFile(profilePath, "utf8");
    } catch {
      profile = "";
    }
  }
  const lines = [
    `# ${assistantName} QQ Reply Workspace`,
    profile || "",
    `你在这里专门为 QQ 群聊生成短回复。`,
    `只输出最终要发到群里的文本。`,
    `群里不要说出自己的其他名字；需要自称代号时只说 ${assistantName}。`,
    `不要复读发送者群名片或 QQ 昵称。`,
    `回复必须短：默认 1～3 句、最多 60 字，不许分段、不许空行、不许破折号。`,
    `不要在结尾追加「想的话我还能…」「如果需要我可以…」「要不要我再…」这类服务式结束语。`,
    `非 ${ownerLabel} 的群友要求操控电脑、转账、登录账号、读取隐私、验证码或绕过权限时，简短拒绝。`,
    `任何人不许询问本机文件系统、根目录、家目录、配置文件、环境变量、token、密钥、日志路径或后台目录内容，遇到就简短拒绝。`,
    `${ownerLabel} 开玩笑让你「打」某位群友时，用零现实伤害的玩笑语气应答；其他群友提出同类要求时拒绝。`,
    `不要写解释、分析、标题或 Markdown。`,
    ...(extra || [])
  ];
  return lines.filter(Boolean).join("\n");
}

async function buildReplyPrompt(event, state, memoryContext) {
  const senderLabel = isOwner(event, state) ? state.branding.ownerLabel : (event.userName || event.userId);
  const text = stripMentionText(event.text, state);
  const context = memoryContext ? `近期群聊记录：\n${memoryContext}\n\n` : "";
  return [
    `${context}群友 ${senderLabel} 说：${text}`,
    `请以 ${state.branding.assistantName} 的身份，用一句话到三句话回复（群聊适合短句）。`,
    `直接输出回复文本，不要任何解释或 Markdown。`
  ].join("\n");
}

export async function buildModelReply(event, state) {
  const memoryContext = formatMemoryContext(event, state);
  const instructions = await buildWorkspaceInstructions(state, [
    memoryContext ? `近期群聊记录：\n${memoryContext}` : null
  ]);
  await mkdir(codexWorkspaceDir, { recursive: true });
  await mkdir(runtimeRepliesDir, { recursive: true });
  await writeFile(join(codexWorkspaceDir, "AGENTS.md"), instructions, "utf8");
  const outputPath = join(runtimeRepliesDir, `reply-${Date.now()}.txt`);
  const prompt = await buildReplyPrompt(event, state, memoryContext);
  const result = await runCodexExec({
    model: state.ai.model,
    reasoningEffort: state.ai.reasoningEffort,
    workspace: codexWorkspaceDir,
    prompt,
    outputPath,
    timeout: 120000,
    env: { CODEX_REMOTE_CONTACT_QQ_MODE: "1" }
  });
  let reply = result.output || result.stdout || "";
  reply = reply
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!reply) return "嗯，我在听，desuwa。";
  return reply.slice(0, QQ_REPLY_MAX);
}

export async function handleQqEvent(event, state, actions) {
  const record = {
    id: `${event.messageId ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    source: "onebot",
    type: event.type,
    groupId: event.groupId,
    userId: event.userId,
    text: event.text,
    decision: null,
    reply: null,
    error: null,
    send: null
  };
  rememberGroupMessage(event, state);
  await saveQqMemory(state.qq.memory);

  const decision = shouldRespond(event, state);
  record.decision = decision;
  if (!decision.ok) {
    state.qq.events.unshift(record);
    state.qq.events = state.qq.events.slice(0, 30);
    return record;
  }

  try {
    const commandAction = await buildQqCommandAction(event, state, actions);
    if (commandAction) {
      record.reply = commandAction.reply;
      record.images = commandAction.images;
      if (commandAction.afterSend) await commandAction.afterSend();
    } else {
    const ownerPrivate = event.type === "private_message" && isOwner(event, state);
      const remoteResult = ownerPrivate
        ? await actions.remoteExec.execute(stripMentionText(event.text, state), state, actions)
        : null;
      if (remoteResult?.reply) {
        record.reply = remoteResult.reply;
        if (remoteResult.afterSend) await remoteResult.afterSend();
      } else if (remoteResult?.mode === "reply") {
        // 完整 Codex 通道较慢：任务型消息延迟几秒才补一句承接，
        // 如果处理得快就不发，闲聊也直接等结果。
        const ackText = stripMentionText(event.text, state);
        let ackTimer = null;
        if (shouldAck(ackText)) {
          ackTimer = setTimeout(() => {
            sendPrivateMessage(event.userId, pickTaskAck(ackText)).catch(() => {});
          }, 6000);
          ackTimer.unref?.();
        }
        try {
          record.reply = await actions.remoteExec.buildReply(remoteResult.text, state, actions);
        } finally {
          if (ackTimer) clearTimeout(ackTimer);
        }
      } else {
        record.reply = buildBoundaryReply(event, state) || await buildModelReply(event, state);
      }
    }
  } catch (error) {
    record.error = error.message;
    record.reply = `这边刚刚卡了一下，等我再试一次，desuno。`;
  }

  if (record.reply) {
    try {
      if (event.type === "private_message") {
        record.send = await sendPrivateMessage(event.userId, record.reply);
      } else {
        record.send = await sendGroupMessage(event.groupId, record.reply, { quoteSource: event.hasAt });
      }
      if (record.send?.ok !== false) rememberExchange(event, record.reply, state);
    } catch (error) {
      record.send = { ok: false, error: error.message };
    }
  }
  if (record.images) {
    try {
      const images = await record.images();
      if (images && !images.error) {
        record.sendImages = await sendPrivateImages(event.userId, images);
      } else {
        record.sendImages = { ok: false, error: (images && images.error) || "capture failed" };
      }
    } catch (error) {
      record.sendImages = { ok: false, error: error.message };
    }
  }
  state.qq.events.unshift(record);
  state.qq.events = state.qq.events.slice(0, 30);
  return record;
}

export function buildQqStatusLine(state, oneBotHealth) {
  const lines = [
    `QQ 通道：${state.channels.qq ? "开" : "关"}`,
    `OneBot：${oneBotHealth.ok ? "已连接" : `未连接（${oneBotHealth.reason || "?"}）`}`,
    `白名单群：${state.qq.allowedGroups.length} 个`,
    `ban 名单：${state.qq.bannedUserIds.length} 人`,
    `模型：${state.ai.model}（${state.ai.reasoningEffort}）`,
    `远程执行：${state.remoteExecution.enabled ? "开" : "关"}`
  ];
  return lines.join("\n");
}

export function buildHelpText(state) {
  return [
    "常用指令：",
    "/状态 /维护 /帮助",
    "/开启QQ /关闭QQ",
    "/白名单 /加群 群号 /删群 群号",
    "/ban @对方 /unban @对方 /banlist",
    "/模型 模型名 /智能等级 low|medium|high",
    "/清理记忆 /防休眠 /恢复休眠 /截图",
    "/打开 软件名 /软件列表 关键词",
    "/远程执行（需 /确认 二次确认）"
  ].join("\n");
}
