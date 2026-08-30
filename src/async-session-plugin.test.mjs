import assert from "node:assert/strict";
import test from "node:test";

import { verifyAppiumMcpNames } from "appium-mcp/core";

import { AsyncSessionPlugin } from "./async-session-plugin.mjs";

class MemoryQueueStore {
  constructor(state = null) {
    this.state = state;
    this.saves = [];
  }

  async load() {
    return this.state == null ? null : structuredClone(this.state);
  }

  async save(state) {
    this.state = structuredClone(state);
    this.saves.push(structuredClone(state));
  }
}

function setup(options = {}) {
  const state = {
    sessions: [],
    createArgs: [],
    deletes: [],
    acquired: 0,
    released: 0,
  };
  const core = {
    listSessions: () => state.sessions,
    getSessionId: () => state.sessions[0]?.sessionId ?? null,
  };
  const tools = new Map();
  const queueStore = options.queueStore ?? new MemoryQueueStore();
  let id = 0;
  let session = 0;
  const plugin = new AsyncSessionPlugin({
    makeId: () => `operation-${++id}`,
    prepareTimeoutMs: 100,
    createTimeoutMs: 100,
    cleanupTimeoutMs: 50,
    queueHeartbeatMs: 100,
    queuePollAfterMs: 20,
    queueRetryMs: 60_000,
    sweepIntervalMs: 0,
    queueStore,
    lease: {
      acquire: async () => {
        state.acquired += 1;
        return `lease-${state.acquired}`;
      },
      release: async () => {
        state.released += 1;
      },
    },
    prepareDevice: async (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "build",
            ready: true,
            udid: args.udid,
            capabilitiesHint: {
              "appium:usePreinstalledWDA": true,
              "appium:prebuiltWDAPath": "/secure/WDA.ipa",
              "appium:udid": args.udid,
            },
          }),
        },
      ],
    }),
    createSession: async (args) => {
      state.createArgs.push(args);
      const sessionId = `session-${++session}`;
      state.sessions = [{ sessionId, ownership: "owned" }];
      return { content: [{ type: "text", text: "created" }] };
    },
    deleteSession: async (sessionId) => {
      state.deletes.push(sessionId);
      state.sessions = state.sessions.filter((item) => item.sessionId !== sessionId);
      return { content: [{ type: "text", text: "deleted" }] };
    },
    ...options,
    queueStore,
  });
  plugin.register({ addTool: (tool) => tools.set(tool.name, tool) }, core);
  return { plugin, tools, state, core, queueStore };
}

async function select(plugin, udid = "selected-device") {
  await plugin.afterCall(
    { toolName: "select_device", args: { platform: "ios", iosDeviceType: "real" } },
    {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ capabilities: { "appium:udid": udid } }) }],
    },
  );
}

function prepareReady(plugin) {
  plugin.prepared = {
    udid: "selected-device",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/secure/WDA.ipa" },
  };
}

function capabilities(url = "https://example.test/") {
  return {
    browserName: "Safari",
    "appium:usePreinstalledWDA": true,
    "appium:prebuiltWDAPath": "/secure/WDA.ipa",
    "appium:initialDeeplinkUrl": url,
  };
}

async function startCreate(tools, clientRequestId, value = capabilities()) {
  return await tools.get("appium_create_session_async").execute({
    action: "start",
    clientRequestId,
    capabilities: value,
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

test("plugin adds two non-colliding lifecycle tools", () => {
  const verification = verifyAppiumMcpNames({ plugins: [new AsyncSessionPlugin()] });
  assert.equal(verification.ok, true);
  assert.equal(verification.toolCount, 33);
});

test("async preparation is private, pollable, and preserved by same-device selection", async () => {
  const { plugin, tools, state } = setup();
  await select(plugin);
  const started = await tools.get("appium_prepare_ios_real_device_async").execute({
    action: "start",
    udid: "selected-device",
    provisioningProfileUuid: "profile-1",
  });
  const operationId = payload(started).operationId;
  await settle();
  const status = await tools.get("appium_prepare_ios_real_device_async").execute({
    action: "status",
    operationId,
  });
  assert.equal(payload(status).state, "ready");
  assert.equal(payload(status).result.capabilitiesHint["appium:udid"], undefined);
  assert.equal(plugin.prepared.udid, "selected-device");
  assert.equal(state.released, 1);

  await select(plugin);
  assert.equal(plugin.prepared.udid, "selected-device");
});

test("failed rebuild does not replace the previous shared preparation", async () => {
  const { plugin, tools } = setup({
    prepareDevice: async () => ({
      content: [{ type: "text", text: JSON.stringify({ mode: "build", ready: false }) }],
    }),
  });
  await select(plugin);
  plugin.prepared = {
    udid: "selected-device",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/old.ipa" },
  };
  const failed = payload(
    await tools.get("appium_prepare_ios_real_device_async").execute({
      action: "start",
      udid: "selected-device",
      forceRebuild: true,
    }),
  );
  await settle();
  assert.equal(plugin.prepareOperation.state, "failed");
  assert.equal(plugin.prepared.capabilitiesHint["appium:prebuiltWDAPath"], "/old.ipa");

  const cached = payload(
    await tools.get("appium_prepare_ios_real_device_async").execute({
      action: "start",
      udid: "selected-device",
    }),
  );
  assert.notEqual(cached.operationId, failed.operationId);
  assert.equal(cached.state, "ready");
  assert.equal(cached.result.capabilitiesHint["appium:prebuiltWDAPath"], "/old.ipa");
});

test("create requires private request and operation handles", async () => {
  const { plugin, tools } = setup();
  await select(plugin);
  prepareReady(plugin);
  const create = tools.get("appium_create_session_async");
  assert.equal((await create.execute({ action: "start", capabilities: capabilities() })).isError, true);
  assert.equal((await create.execute({ action: "status" })).isError, true);
  assert.equal((await create.execute({ action: "cancel" })).isError, true);
});

test("create still rejects native, mismatched, unprepared, and unsafe capabilities", async () => {
  const { plugin, tools } = setup();
  await select(plugin);
  const create = tools.get("appium_create_session_async");
  for (const [index, value] of [
    { browserName: "Safari", "appium:app": "/tmp/app.ipa" },
    { browserName: "Safari", "appium:udid": "other-device" },
    { browserName: "Safari", "appium:initialDeeplinkUrl": "file:///tmp/test" },
    { browserName: "Safari" },
    null,
    [],
  ].entries()) {
    const result = await create.execute({ action: "start", clientRequestId: `invalid-${index}`, capabilities: value });
    assert.equal(result.isError, true);
  }
});

test("FIFO queue reports positions and advances only after active session deletion", async () => {
  const { plugin, tools, state } = setup();
  await select(plugin);
  prepareReady(plugin);

  const first = payload(await startCreate(tools, "request-a"));
  assert.equal(first.state, "queued");
  assert.equal(first.queuePosition, 1);
  await settle();
  assert.equal(payload(await tools.get("appium_create_session_async").execute({ action: "status", operationId: first.operationId })).state, "ready");

  const second = payload(await startCreate(tools, "request-b", capabilities("https://second.test/")));
  const third = payload(await startCreate(tools, "request-c", capabilities("https://third.test/")));
  assert.equal(second.queuePosition, 1);
  assert.equal(second.queueDepth, 1);
  assert.equal(third.queuePosition, 2);
  assert.equal(third.queueDepth, 2);

  state.sessions = [];
  await plugin.afterCall(
    { toolName: "appium_session_management", args: { action: "delete", sessionId: "session-1" } },
    { isError: false, content: [] },
  );
  await settle();
  assert.equal(payload(await tools.get("appium_create_session_async").execute({ action: "status", operationId: second.operationId })).state, "ready");
  const thirdWaiting = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: third.operationId }),
  );
  assert.equal(thirdWaiting.queuePosition, 1);
  assert.equal(thirdWaiting.waitingReason, "active_session");
  assert.equal(state.createArgs.length, 2);
});

test("clientRequestId is idempotent and conflicts on different capabilities", async () => {
  const { plugin, tools } = setup();
  await select(plugin);
  prepareReady(plugin);
  const first = payload(await startCreate(tools, "stable-request"));
  const retry = payload(await startCreate(tools, "stable-request"));
  assert.equal(retry.operationId, first.operationId);
  const conflict = await startCreate(tools, "stable-request", capabilities("https://different.test/"));
  assert.equal(conflict.isError, true);
  assert.equal(payload(conflict).error.code, "IDEMPOTENCY_CONFLICT");
});

test("queue capacity rejects only the new request", async () => {
  let resolveCreate;
  const pending = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const { plugin, tools, state } = setup({
    maxQueueSize: 1,
    requirePreparation: false,
    createSession: async (args) => {
      state.createArgs.push(args);
      return await pending;
    },
  });
  await select(plugin);
  const first = payload(await startCreate(tools, "request-a", { browserName: "Safari" }));
  await settle();
  const second = payload(await startCreate(tools, "request-b", { browserName: "Safari" }));
  assert.equal(second.queuePosition, 1);
  const full = await startCreate(tools, "request-c", { browserName: "Safari" });
  assert.equal(full.isError, true);
  assert.equal(payload(full).error.code, "QUEUE_FULL");
  resolveCreate({ isError: true, content: [{ type: "text", text: "stopped" }] });
  await settle();
  assert.ok(first.operationId);
});

test("cancelling a middle request immediately recalculates positions", async () => {
  const { plugin, tools } = setup();
  await select(plugin);
  prepareReady(plugin);
  await startCreate(tools, "request-a");
  await settle();
  const second = payload(await startCreate(tools, "request-b", capabilities("https://second.test/")));
  const third = payload(await startCreate(tools, "request-c", capabilities("https://third.test/")));
  const cancelled = payload(
    await tools.get("appium_create_session_async").execute({ action: "cancel", operationId: second.operationId }),
  );
  assert.equal(cancelled.state, "cancelled");
  const waiting = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: third.operationId }),
  );
  assert.equal(waiting.queuePosition, 1);
  assert.equal(waiting.queueDepth, 1);
});

test("status heartbeat renews waiting requests and stale requests expire", async () => {
  let now = 1_000;
  const { plugin, tools } = setup({ now: () => now });
  await select(plugin);
  prepareReady(plugin);
  await startCreate(tools, "request-a");
  await settle();
  const second = payload(await startCreate(tools, "request-b", capabilities("https://second.test/")));
  const third = payload(await startCreate(tools, "request-c", capabilities("https://third.test/")));

  now += 60;
  assert.equal(
    payload(await tools.get("appium_create_session_async").execute({ action: "status", operationId: second.operationId })).state,
    "queued",
  );
  now += 60;
  const secondAlive = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: second.operationId }),
  );
  const thirdExpired = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: third.operationId }),
  );
  assert.equal(secondAlive.state, "queued");
  assert.equal(thirdExpired.state, "expired");
  assert.equal(thirdExpired.error.code, "QUEUE_HEARTBEAT_EXPIRED");
});

test("cancel while creating deletes a late-created session and advances safely", async () => {
  let resolveCreate;
  const pending = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const { plugin, tools, state } = setup({ createSession: () => pending, requirePreparation: false });
  await select(plugin);
  const started = payload(await startCreate(tools, "request-a", { browserName: "Safari" }));
  await settle();
  const cancelling = payload(
    await tools.get("appium_create_session_async").execute({ action: "cancel", operationId: started.operationId }),
  );
  assert.equal(cancelling.state, "cancelling");
  state.sessions = [{ sessionId: "late-session", ownership: "owned" }];
  resolveCreate({ content: [{ type: "text", text: "created late" }] });
  await settle();
  assert.deepEqual(state.deletes, ["late-session"]);
  assert.equal(plugin.operations.get(started.operationId).state, "cancelled");
  assert.equal(state.released, 1);
});

test("cleanup failure retains the lease and blocks the next request", async () => {
  const { plugin, tools, state } = setup({
    deleteSession: async () => ({ isError: true, content: [{ type: "text", text: "cannot delete" }] }),
  });
  await select(plugin);
  prepareReady(plugin);
  const first = payload(await startCreate(tools, "request-a"));
  await settle();
  const second = payload(await startCreate(tools, "request-b", capabilities("https://second.test/")));
  await tools.get("appium_create_session_async").execute({ action: "cancel", operationId: first.operationId });
  await settle();
  assert.equal(plugin.operations.get(first.operationId).state, "cleanup_failed");
  assert.equal(plugin.operations.get(second.operationId).state, "queued");
  assert.equal(state.released, 0);
});

test("external lease contention leaves the head request queued and retryable", async () => {
  const { plugin, tools } = setup({
    requirePreparation: false,
    lease: {
      acquire: async () => {
        throw new Error("another bridge owns the phone");
      },
      release: async () => {},
    },
  });
  await select(plugin);
  const started = payload(await startCreate(tools, "request-a", { browserName: "Safari" }));
  await settle();
  const waiting = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: started.operationId }),
  );
  assert.equal(waiting.state, "queued");
  assert.equal(waiting.queuePosition, 1);
  assert.equal(waiting.waitingReason, "external_lease");
});

test("timed-out creation cleans a late session before advancing", async () => {
  let resolveFirst;
  const firstPending = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const { plugin, tools, state } = setup({
    requirePreparation: false,
    createTimeoutMs: 5,
    createSession: async (args) => {
      state.createArgs.push(args);
      calls += 1;
      if (calls === 1) return await firstPending;
      state.sessions = [{ sessionId: "second-session", ownership: "owned" }];
      return { content: [{ type: "text", text: "created" }] };
    },
  });
  await select(plugin);
  const first = payload(await startCreate(tools, "request-a", { browserName: "Safari" }));
  await settle();
  const second = payload(await startCreate(tools, "request-b", { browserName: "Safari" }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(plugin.operations.get(first.operationId).state, "timed_out");
  state.sessions = [{ sessionId: "late-session", ownership: "owned" }];
  resolveFirst({ content: [{ type: "text", text: "created late" }] });
  await settle();
  assert.deepEqual(state.deletes, ["late-session"]);
  assert.equal(plugin.operations.get(first.operationId).state, "timed_out");
  assert.equal(plugin.operations.get(second.operationId).state, "ready");
});

test("restart restores FIFO waiters behind a confirmation heartbeat and interrupts active work", async () => {
  const store = new MemoryQueueStore({
    version: 1,
    savedAt: 900,
    queue: ["waiting-operation"],
    operations: [
      {
        id: "active-operation",
        clientRequestId: "active-request",
        inputHash: "active-hash",
        state: "ready",
        stage: "finished",
        enqueuedAt: 100,
        startedAt: 200,
        updatedAt: 300,
        lastHeartbeatAt: 100,
        cleanupPending: false,
        error: null,
        args: null,
      },
      {
        id: "waiting-operation",
        clientRequestId: "waiting-request",
        inputHash: "waiting-hash",
        state: "queued",
        stage: "waiting_for_iphone",
        enqueuedAt: 400,
        startedAt: null,
        updatedAt: 500,
        lastHeartbeatAt: 500,
        cleanupPending: false,
        error: null,
        args: { capabilities: { browserName: "Safari", "appium:udid": "private-device" } },
      },
    ],
  });
  const { plugin, tools } = setup({ queueStore: store, now: () => 1_000, requirePreparation: false });
  await plugin.initialize({ core: plugin.core });
  assert.equal(plugin.operations.get("waiting-operation").waitingReason, "restart_confirmation");
  assert.equal(plugin.activeOperation, null);

  const confirmed = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: "waiting-operation" }),
  );
  assert.equal(confirmed.state, "queued");
  await settle();
  assert.equal(plugin.operations.get("waiting-operation").state, "ready");
  const interrupted = payload(
    await tools.get("appium_create_session_async").execute({ action: "status", operationId: "active-operation" }),
  );
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.error.code, "BRIDGE_RESTARTED");
});

test("invalid persisted state fails initialization closed", async () => {
  const { plugin, core } = setup({ queueStore: new MemoryQueueStore({ version: 99 }) });
  await assert.rejects(plugin.initialize({ core }), /invalid or unsupported/i);
});

test("restoration prunes terminal history by the configured cap", async () => {
  const terminal = (id, updatedAt) => ({
    id,
    clientRequestId: `${id}-request`,
    inputHash: `${id}-hash`,
    state: "closed",
    stage: "finished",
    enqueuedAt: updatedAt,
    startedAt: updatedAt,
    updatedAt,
    lastHeartbeatAt: updatedAt,
    cleanupPending: false,
    error: null,
    args: null,
  });
  const store = new MemoryQueueStore({
    version: 1,
    savedAt: 30,
    queue: [],
    operations: [terminal("oldest", 10), terminal("middle", 20), terminal("newest", 30)],
  });
  const { plugin, core } = setup({ queueStore: store, now: () => 40, maxTerminalOperations: 1 });
  await plugin.initialize({ core });
  assert.deepEqual([...plugin.operations.keys()], ["newest"]);
  assert.equal(store.state.operations.length, 1);
});

test("clean shutdown interrupts active work but preserves waiting FIFO state", async () => {
  const { plugin, tools, state, queueStore } = setup();
  await select(plugin);
  prepareReady(plugin);
  const first = payload(await startCreate(tools, "request-a"));
  await settle();
  const second = payload(await startCreate(tools, "request-b", capabilities("https://second.test/")));
  await plugin.shutdown();
  assert.deepEqual(state.deletes, ["session-1"]);
  assert.equal(plugin.operations.get(first.operationId).state, "interrupted");
  assert.equal(plugin.operations.get(second.operationId).state, "queued");
  assert.deepEqual(queueStore.state.queue, [second.operationId]);
});

test("public queue payload and persisted active state do not expose another request input", async () => {
  const { plugin, tools, queueStore } = setup();
  await select(plugin);
  prepareReady(plugin);
  await startCreate(tools, "request-a", capabilities("https://secret.example.test/path"));
  await settle();
  const waiting = await startCreate(tools, "request-b", capabilities("https://private.example.test/path"));
  const publicText = JSON.stringify(payload(waiting));
  assert.doesNotMatch(publicText, /clientRequestId|private\.example|selected-device|session-1/);
  const activeSaved = queueStore.state.operations.find((operation) => operation.state === "ready");
  assert.equal(activeSaved.args, null);
});
