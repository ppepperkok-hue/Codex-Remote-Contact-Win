import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemoteExecutionReply,
  DEFAULT_REMOTE_EXECUTION_SANDBOX,
  executeRemoteExecutionCommand,
  LEGACY_DEFAULT_REMOTE_EXECUTION_SANDBOX,
  normalizeSandbox,
  REMOTE_EXECUTION_SANDBOXES,
  resolveRemoteExecutionSandbox
} from "../src/remote-exec.js";
import { defaultSettings, loadJsonFile, saveJsonFile } from "../src/settings.js";
import { applySettingsToState, buildSettingsSnapshot } from "../src/state-settings.js";
import { handleQqEvent, normalizeOneBotEvent } from "../src/qq.js";

const SANDBOX_ENV = "CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_SANDBOX";

async function withSandboxEnv(value, fn) {
  const previous = process.env[SANDBOX_ENV];
  if (value === undefined) delete process.env[SANDBOX_ENV];
  else process.env[SANDBOX_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[SANDBOX_ENV];
    else process.env[SANDBOX_ENV] = previous;
  }
}

// Reproduces the reported upgrade path: an old release wrote the then-default
// danger-full-access into data/settings.json without recording a choice.
async function withLegacySettings(remoteExecution, fn) {
  const dir = await mkdtemp(join(tmpdir(), "crc-legacy-settings-"));
  const file = join(dir, "settings.json");
  await writeFile(file, `${JSON.stringify({ version: 1, remoteExecution }, null, 2)}\n`, "utf8");
  try {
    return await fn({ file, settings: await loadJsonFile(file, {}) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Temporary settings.json fixture with the full shape a live hub loads.
async function withSettingsFile(remoteExecution, fn) {
  const dir = await mkdtemp(join(tmpdir(), "crc-settings-"));
  const file = join(dir, "settings.json");
  await writeFile(
    file,
    `${JSON.stringify(
      {
        version: 1,
        qq: { allowedGroups: [], ownerUserIds: ["10001"], bannedUserIds: [] },
        ai: { model: "auto", reasoningEffort: "medium" },
        remoteExecution,
        branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  try {
    return await fn({ file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function freshState() {
  return {
    settings: null,
    channels: { qq: true },
    qq: {
      allowedGroups: [],
      ownerUserIds: ["10001"],
      bannedUserIds: [],
      memory: { entries: {}, recentMessages: {} },
      events: []
    },
    ai: {},
    lastOpenedApp: null,
    branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] },
    remoteExecution: {
      enabled: false,
      pendingAction: null,
      idleTimer: null,
      lastActiveAt: 0,
      model: "",
      reasoningEffort: "",
      skill: "",
      sandbox: "",
      sandboxExplicit: false,
      memory: { entries: [] }
    }
  };
}

// Mirrors src/server.js saveStateSettings(): the snapshot is what hits disk.
async function saveSnapshot(file, state) {
  const settings = buildSettingsSnapshot(state);
  state.settings = settings;
  await saveJsonFile(file, settings);
}

test("default remote execution sandbox matches the documented read-only value", () => {
  assert.equal(DEFAULT_REMOTE_EXECUTION_SANDBOX, "read-only");
  assert.equal(LEGACY_DEFAULT_REMOTE_EXECUTION_SANDBOX, "danger-full-access");
  assert.equal(defaultSettings.remoteExecution.sandbox, "read-only");
  assert.equal(defaultSettings.remoteExecution.sandboxExplicit, false);
  assert.deepEqual(REMOTE_EXECUTION_SANDBOXES, ["read-only", "workspace-write", "danger-full-access"]);
  assert.equal(resolveRemoteExecutionSandbox({}, {}), "read-only");
});

test("legacy persisted danger-full-access is demoted and never overrides env or the safe default", async () => {
  await withLegacySettings({ skill: "none", sandbox: "danger-full-access" }, async ({ file, settings }) => {
    // The fixture is what old versions actually stored: no sandboxExplicit marker.
    assert.equal(settings.remoteExecution.sandbox, "danger-full-access");
    assert.equal(settings.remoteExecution.sandboxExplicit, undefined);
    assert.equal(resolveRemoteExecutionSandbox(settings, {}), "read-only");
    assert.equal(
      resolveRemoteExecutionSandbox(settings, { [SANDBOX_ENV]: "read-only" }),
      "read-only"
    );
    assert.equal(
      resolveRemoteExecutionSandbox(settings, { [SANDBOX_ENV]: "workspace-write" }),
      "workspace-write"
    );
    assert.equal(
      resolveRemoteExecutionSandbox(settings, { [SANDBOX_ENV]: "danger-full-access" }),
      "danger-full-access"
    );
    // Reading a legacy fixture must not rewrite the owner's file behind their back.
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.remoteExecution.sandbox, "danger-full-access");
  });
});

test("legacy non-default values are kept because old releases never wrote them by default", async () => {
  await withLegacySettings({ sandbox: "workspace-write" }, ({ settings }) => {
    assert.equal(resolveRemoteExecutionSandbox(settings, {}), "workspace-write");
  });
  await withLegacySettings({ sandbox: "read-only" }, ({ settings }) => {
    assert.equal(resolveRemoteExecutionSandbox(settings, {}), "read-only");
  });
});

test("explicit current-version choice keeps danger-full-access, but an explicit env override still wins", () => {
  const explicitDanger = { remoteExecution: { sandbox: "danger-full-access", sandboxExplicit: true } };
  assert.equal(resolveRemoteExecutionSandbox(explicitDanger, {}), "danger-full-access");
  assert.equal(
    resolveRemoteExecutionSandbox(explicitDanger, { [SANDBOX_ENV]: "read-only" }),
    "read-only"
  );
  assert.equal(
    resolveRemoteExecutionSandbox(
      { remoteExecution: { sandbox: "danger-full-access", sandboxExplicit: "true" } },
      {}
    ),
    "read-only"
  );
});

test("unknown or malformed sandbox values fall back to read-only instead of full access", () => {
  assert.equal(normalizeSandbox("DANGER-FULL-ACCESS"), "danger-full-access");
  assert.equal(normalizeSandbox("root"), "read-only");
  assert.equal(normalizeSandbox(""), "read-only");
  assert.equal(resolveRemoteExecutionSandbox({ remoteExecution: { sandbox: "unrestricted" } }, {}), "read-only");
  assert.equal(
    resolveRemoteExecutionSandbox({ remoteExecution: { sandbox: "danger-full-access", sandboxExplicit: false } }, {}),
    "read-only"
  );
});

test("/沙箱 danger-full-access records an explicit current-version choice", async () => {
  const state = { remoteExecution: { sandbox: "read-only", sandboxExplicit: false } };
  let saves = 0;
  const actions = { saveStateSettings: async () => { saves += 1; } };

  const result = await withSandboxEnv(undefined, () =>
    executeRemoteExecutionCommand("/沙箱 danger-full-access", state, actions)
  );

  assert.equal(result.ok, true);
  assert.equal(saves, 1);
  assert.equal(state.remoteExecution.sandbox, "danger-full-access");
  assert.equal(state.remoteExecution.sandboxExplicit, true);
  assert.equal(resolveRemoteExecutionSandbox(state, {}), "danger-full-access");
});

test("/沙箱 reports when an env override keeps the effective sandbox lower", async () => {
  const state = { remoteExecution: { sandbox: "read-only", sandboxExplicit: false } };
  const actions = { saveStateSettings: async () => {} };

  await withSandboxEnv("read-only", async () => {
    const result = await executeRemoteExecutionCommand("沙箱 danger-full-access", state, actions);
    assert.equal(result.ok, true);
    assert.match(result.reply, /固定为 read-only/);
    assert.equal(state.remoteExecution.sandbox, "danger-full-access");
    assert.equal(resolveRemoteExecutionSandbox(state), "read-only");
  });
});

test("env pin + unrelated save keeps workspace-write and restores it after restart", async () => {
  await withSettingsFile(
    { model: "auto", reasoningEffort: "medium", skill: "none", sandbox: "workspace-write", sandboxExplicit: true },
    async ({ file }) => {
      const first = freshState();
      await withSandboxEnv("danger-full-access", async () => {
        applySettingsToState(first, await loadJsonFile(file, {}));
        // The env pin is what remote execution actually uses...
        assert.equal(resolveRemoteExecutionSandbox(first), "danger-full-access");
        // ...but state keeps the owner's recorded choice.
        assert.equal(first.remoteExecution.sandbox, "workspace-write");
        // An unrelated save (e.g. /模型, /加群, opening an app) must not write
        // the env-resolved value into the owner's file.
        await saveSnapshot(file, first);
      });

      const saved = JSON.parse(await readFile(file, "utf8"));
      assert.equal(saved.remoteExecution.sandbox, "workspace-write");
      assert.equal(saved.remoteExecution.sandboxExplicit, true);

      // Env removed + restart: the original choice is still effective.
      const restarted = freshState();
      applySettingsToState(restarted, await loadJsonFile(file, {}));
      assert.equal(restarted.remoteExecution.sandbox, "workspace-write");
      assert.equal(resolveRemoteExecutionSandbox(restarted), "workspace-write");
      assert.equal(resolveRemoteExecutionSandbox(restarted, {}), "workspace-write");
    }
  );
});

test("an env pin never promotes legacy unmarked danger-full-access into a saved choice", async () => {
  await withSettingsFile({ skill: "none", sandbox: "danger-full-access" }, async ({ file }) => {
    const first = freshState();
    await withSandboxEnv("workspace-write", async () => {
      applySettingsToState(first, await loadJsonFile(file, {}));
      assert.equal(resolveRemoteExecutionSandbox(first), "workspace-write");
      await saveSnapshot(file, first);
    });

    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.remoteExecution.sandbox, "danger-full-access");
    assert.equal(saved.remoteExecution.sandboxExplicit, false);

    // Still demoted after the temporary env override is gone.
    const restarted = freshState();
    applySettingsToState(restarted, await loadJsonFile(file, {}));
    assert.equal(resolveRemoteExecutionSandbox(restarted), "read-only");
  });
});

test("QQ owner /状态 reports the effective sandbox and keeps the persisted choice intact", async () => {
  const state = freshState();
  applySettingsToState(state, {
    qq: { ownerUserIds: ["10001"], allowedGroups: [] },
    branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] },
    remoteExecution: {
      model: "auto",
      reasoningEffort: "medium",
      skill: "none",
      sandbox: "workspace-write",
      sandboxExplicit: true
    }
  });
  const event = normalizeOneBotEvent({
    post_type: "message",
    message_type: "private",
    self_id: 99999,
    user_id: 10001,
    message_id: 101,
    message: [{ type: "text", data: { text: "/状态" } }]
  });
  let statusCalls = 0;
  const actions = {
    saveQqMemory: async () => {},
    status: () => {
      statusCalls += 1;
      return "QQ 通道：开\n远程执行：关";
    },
    remoteExec: { execute: executeRemoteExecutionCommand, buildReply: async () => "" }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "ok", data: {} }) });
  try {
    await withSandboxEnv("read-only", async () => {
      const record = await handleQqEvent(event, state, actions);
      assert.match(record.reply, /沙箱：read-only/);
      assert.doesNotMatch(record.reply, /沙箱：workspace-write/);
    });

    const record = await handleQqEvent(event, state, actions);
    assert.match(record.reply, /沙箱：workspace-write/);
    assert.match(record.reply, /远程执行模式：关/);

    assert.equal(statusCalls, 0);
    // Reporting status must not rewrite the recorded choice.
    assert.equal(state.remoteExecution.sandbox, "workspace-write");
    assert.equal(state.remoteExecution.sandboxExplicit, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner group /状态 keeps the short QQ status line", async () => {
  const state = freshState();
  applySettingsToState(state, {
    qq: { ownerUserIds: ["10001"], allowedGroups: ["12345"] },
    branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] },
    remoteExecution: { sandbox: "workspace-write", sandboxExplicit: true }
  });
  const event = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    self_id: 99999,
    group_id: 12345,
    user_id: 10001,
    message_id: 102,
    message: [
      { type: "at", data: { qq: "99999" } },
      { type: "text", data: { text: " /状态" } }
    ]
  });
  const actions = {
    saveQqMemory: async () => {},
    status: () => "QQ 通道：开\n远程执行：关",
    remoteExec: { execute: executeRemoteExecutionCommand, buildReply: async () => "" }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "ok", data: {} }) });
  try {
    await withSandboxEnv("danger-full-access", async () => {
      const record = await handleQqEvent(event, state, actions);
      assert.equal(record.reply, "QQ 通道：开\n远程执行：关");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner private execution passes the resolved sandbox and env marker to Codex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crc-remote-exec-"));
  const state = {
    branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] },
    remoteExecution: {
      model: "auto",
      reasoningEffort: "medium",
      skill: "none",
      sandbox: "danger-full-access",
      sandboxExplicit: true,
      memory: { entries: [] }
    }
  };
  let captured = null;
  const actions = {
    workspaceDir: dir,
    repliesDir: dir,
    saveRemoteExecutionMemory: async () => {},
    runCodexExec: async (options) => {
      captured = options;
      return { output: "done" };
    }
  };

  try {
    await withSandboxEnv("read-only", () => buildRemoteExecutionReply("hello", state, actions));
    assert.equal(captured.sandbox, "read-only");
    assert.equal(captured.workspace, dir);
    assert.equal(captured.prompt, "hello");
    assert.equal(captured.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MODE, "1");

    const instructions = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.match(instructions, /当前沙箱级别：read-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary owner private message still reaches remote execution", async () => {
  const state = {
    channels: { qq: true },
    qq: {
      ownerUserIds: ["10001"],
      bannedUserIds: [],
      allowedGroups: [],
      memory: { entries: {}, recentMessages: {} },
      events: []
    },
    branding: { assistantName: "assistant", ownerLabel: "owner", assistantMentions: ["@assistant"] },
    remoteExecution: {
      enabled: true,
      model: "auto",
      reasoningEffort: "medium",
      skill: "none",
      sandbox: "read-only",
      sandboxExplicit: false,
      memory: { entries: [] }
    }
  };
  const event = normalizeOneBotEvent({
    post_type: "message",
    message_type: "private",
    self_id: 99999,
    user_id: 10001,
    message_id: 42,
    message: [{ type: "text", data: { text: "hello there" } }]
  });
  const calls = [];
  const actions = {
    saveQqMemory: async () => {},
    remoteExec: {
      execute: async (text) => {
        calls.push(["execute", text]);
        return { mode: "reply", text };
      },
      buildReply: async (text) => {
        calls.push(["buildReply", text]);
        return "普通回复";
      }
    }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "ok", data: {} }) });
  try {
    const record = await handleQqEvent(event, state, actions);
    assert.equal(record.reply, "普通回复");
    assert.deepEqual(calls, [
      ["execute", "hello there"],
      ["buildReply", "hello there"]
    ]);
    assert.equal(record.send.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
