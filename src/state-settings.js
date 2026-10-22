import { defaultSettings } from "./settings.js";
import { normalizeSandbox } from "./remote-exec.js";

/*
 * Persisted owner choice vs. effective runtime value.
 *
 * state.remoteExecution.sandbox always holds the choice recorded in
 * data/settings.json (or the safe default when the file has none). The
 * effective value -- env override, explicit marker, legacy demotion applied --
 * is derived on every read through resolveRemoteExecutionSandbox(state) and is
 * never written back. Persisting the derived value would silently turn a
 * temporary env pin into a permanent change to the owner's choice.
 */

export function applySettingsToState(state, settings) {
  state.settings = settings;
  state.qq.allowedGroups = settings.qq?.allowedGroups || [];
  state.qq.ownerUserIds = settings.qq?.ownerUserIds || [];
  state.qq.bannedUserIds = settings.qq?.bannedUserIds || [];
  state.ai = settings.ai || {};
  state.lastOpenedApp = settings.lastOpenedApp || null;
  state.branding = settings.branding || {};
  state.remoteExecution.model = settings.remoteExecution?.model || "gpt-5.4";
  state.remoteExecution.reasoningEffort = settings.remoteExecution?.reasoningEffort || "medium";
  state.remoteExecution.skill = settings.remoteExecution?.skill || "none";
  state.remoteExecution.sandboxExplicit = settings.remoteExecution?.sandboxExplicit === true;
  state.remoteExecution.sandbox = normalizeSandbox(settings.remoteExecution?.sandbox);
  return state;
}

export function buildSettingsSnapshot(state) {
  return {
    ...(state.settings || {}),
    version: 1,
    updatedAt: new Date().toISOString(),
    qq: {
      allowedGroups: state.qq.allowedGroups,
      ownerUserIds: state.qq.ownerUserIds,
      bannedUserIds: state.qq.bannedUserIds,
      proactive: state.settings?.qq?.proactive || { ...defaultSettings.qq.proactive }
    },
    ai: { ...state.ai },
    remoteExecution: {
      model: state.remoteExecution.model,
      reasoningEffort: state.remoteExecution.reasoningEffort,
      skill: state.remoteExecution.skill,
      // Only the owner's recorded choice, never the env-resolved value.
      sandbox: normalizeSandbox(state.remoteExecution.sandbox),
      sandboxExplicit: state.remoteExecution.sandboxExplicit === true
    },
    lastOpenedApp: state.lastOpenedApp,
    branding: { ...state.branding }
  };
}
