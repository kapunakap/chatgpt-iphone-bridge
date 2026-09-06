import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DevicePoolPlugin } from "./device-pool-plugin.mjs";

function selectionResult(udid) {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({ capabilities: { "appium:udid": udid } }),
      },
    ],
  };
}

async function select(plugin, udid) {
  await plugin.afterCall(
    { toolName: "select_device", args: { platform: "ios", iosDeviceType: "real", deviceUdid: udid } },
    selectionResult(udid),
  );
}

function capabilities(udid) {
  return {
    browserName: "Safari",
    "appium:udid": udid,
    "appium:usePreinstalledWDA": true,
    "appium:prebuiltWDAPath": `/secure/${udid}.ipa`,
  };
}

async function settle(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("different devices run concurrently while each device keeps FIFO session order", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-device-pool-"));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));

  const state = { sessions: [], starts: [], resolvers: new Map(), counts: new Map() };
  const core = { listSessions: () => state.sessions };
  const createSession = async ({ capabilities: createCapabilities }) => {
    const udid = createCapabilities["appium:udid"];
    const count = (state.counts.get(udid) ?? 0) + 1;
    state.counts.set(udid, count);
    const key = `${udid}-${count}`;
    state.starts.push(key);
    await new Promise((resolve) => state.resolvers.set(key, resolve));
    const sessionId = `session-${key}`;
    state.sessions.push({ sessionId, ownership: "owned", capabilities: createCapabilities });
    return {
      content: [{ type: "text", text: `IOS session created successfully with ID: ${sessionId}` }],
    };
  };
  const deleteSession = async (sessionId) => {
    state.sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
    return { isError: false, content: [{ type: "text", text: "deleted" }] };
  };

  const plugin = new DevicePoolPlugin({
    runtimeRoot,
    workerOptions: {
      createSession,
      deleteSession,
      checkDeviceReady: async () => ({ locked: false }),
      queueRetryMs: 5,
      sweepIntervalMs: 0,
    },
  });
  plugin.register({ addTool() {} }, core);
  await plugin.initialize({ core });
  t.after(() => plugin.shutdown().catch(() => {}));

  await select(plugin, "device-a");
  await select(plugin, "device-b");
  plugin.workers.get("device-a").prepared = {
    udid: "device-a",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/secure/device-a.ipa" },
  };
  plugin.workers.get("device-b").prepared = {
    udid: "device-b",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/secure/device-b.ipa" },
  };

  const firstA = await plugin.executeTool("create", {
    action: "start",
    udid: "device-a",
    clientRequestId: "request-a-1",
    capabilities: capabilities("device-a"),
  });
  const secondA = await plugin.executeTool("create", {
    action: "start",
    udid: "device-a",
    clientRequestId: "request-a-2",
    capabilities: capabilities("device-a"),
  });
  const firstB = await plugin.executeTool("create", {
    action: "start",
    udid: "device-b",
    clientRequestId: "request-b-1",
    capabilities: capabilities("device-b"),
  });

  await settle();
  assert.deepEqual(new Set(state.starts), new Set(["device-a-1", "device-b-1"]));
  assert.equal(state.starts.includes("device-a-2"), false);

  state.resolvers.get("device-b-1")();
  state.resolvers.get("device-a-1")();
  await settle();

  const firstAStatus = await plugin.executeTool("create", {
    action: "status",
    operationId: firstA.structuredContent.operationId,
  });
  const firstBStatus = await plugin.executeTool("create", {
    action: "status",
    operationId: firstB.structuredContent.operationId,
  });
  const secondAStatus = await plugin.executeTool("create", {
    action: "status",
    operationId: secondA.structuredContent.operationId,
  });
  assert.equal(firstAStatus.structuredContent.state, "ready");
  assert.equal(firstBStatus.structuredContent.state, "ready");
  assert.equal(secondAStatus.structuredContent.state, "queued");

  state.sessions = state.sessions.filter((session) => session.sessionId !== "session-device-a-1");
  await plugin.afterCall(
    { toolName: "appium_session_management", args: { action: "delete", sessionId: "session-device-a-1" } },
    { isError: false, content: [] },
  );
  await settle();
  assert.equal(state.starts.includes("device-a-2"), true);

  state.resolvers.get("device-a-2")();
  await settle();
  const secondAReady = await plugin.executeTool("create", {
    action: "status",
    operationId: secondA.structuredContent.operationId,
  });
  assert.equal(secondAReady.structuredContent.state, "ready");

  for (const sessionId of ["session-device-a-2", "session-device-b-1"]) {
    state.sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
    await plugin.afterCall(
      { toolName: "appium_session_management", args: { action: "delete", sessionId } },
      { isError: false, content: [] },
    );
  }
});

test("WDA preparation is serialized across devices without blocking unrelated device ownership", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-device-pool-wda-"));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const core = { listSessions: () => [] };
  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const prepareDevice = async (args) => {
    if (args.udid === "device-a") await gateA;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "build",
            ready: true,
            udid: args.udid,
            capabilitiesHint: {
              "appium:udid": args.udid,
              "appium:prebuiltWDAPath": `/secure/${args.udid}.ipa`,
            },
          }),
        },
      ],
    };
  };

  const plugin = new DevicePoolPlugin({
    runtimeRoot,
    workerOptions: { prepareDevice, sweepIntervalMs: 0 },
  });
  plugin.register({ addTool() {} }, core);
  await plugin.initialize({ core });
  t.after(() => plugin.shutdown().catch(() => {}));
  await select(plugin, "device-a");
  await select(plugin, "device-b");

  const first = await plugin.executeTool("prepare", {
    action: "start",
    udid: "device-a",
    provisioningProfileUuid: "profile-a",
  });
  await settle();
  const blocked = await plugin.executeTool("prepare", {
    action: "start",
    udid: "device-b",
    provisioningProfileUuid: "profile-b",
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, "LEASE_BUSY");

  releaseA();
  await settle();
  const firstReady = await plugin.executeTool("prepare", {
    action: "status",
    operationId: first.structuredContent.operationId,
  });
  assert.equal(firstReady.structuredContent.state, "ready");

  const second = await plugin.executeTool("prepare", {
    action: "start",
    udid: "device-b",
    provisioningProfileUuid: "profile-b",
  });
  await settle();
  const secondReady = await plugin.executeTool("prepare", {
    action: "status",
    operationId: second.structuredContent.operationId,
  });
  assert.equal(secondReady.structuredContent.state, "ready");
});

test("per-device queued requests survive restart and resume only after heartbeat", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-device-pool-restart-"));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));

  const state = {
    sessions: [
      {
        sessionId: "external-device-a",
        ownership: "owned",
        capabilities: { "appium:udid": "device-a" },
      },
    ],
  };
  const core = { listSessions: () => state.sessions };
  const createSession = async ({ capabilities: createCapabilities }) => {
    const sessionId = "session-after-restart";
    state.sessions.push({ sessionId, ownership: "owned", capabilities: createCapabilities });
    return {
      content: [{ type: "text", text: `IOS session created successfully with ID: ${sessionId}` }],
    };
  };

  const firstPlugin = new DevicePoolPlugin({
    runtimeRoot,
    workerOptions: {
      createSession,
      checkDeviceReady: async () => ({ locked: false }),
      queueRetryMs: 5,
      sweepIntervalMs: 0,
    },
  });
  firstPlugin.register({ addTool() {} }, core);
  await firstPlugin.initialize({ core });
  await select(firstPlugin, "device-a");
  firstPlugin.workers.get("device-a").prepared = {
    udid: "device-a",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/secure/device-a.ipa" },
  };

  const queued = await firstPlugin.executeTool("create", {
    action: "start",
    udid: "device-a",
    clientRequestId: "restart-request",
    capabilities: capabilities("device-a"),
  });
  await settle();
  const beforeRestart = await firstPlugin.executeTool("create", {
    action: "status",
    operationId: queued.structuredContent.operationId,
  });
  assert.equal(beforeRestart.structuredContent.state, "queued");
  await firstPlugin.shutdown();

  state.sessions = [];
  const secondPlugin = new DevicePoolPlugin({
    runtimeRoot,
    workerOptions: {
      createSession,
      checkDeviceReady: async () => ({ locked: false }),
      queueRetryMs: 5,
      sweepIntervalMs: 0,
      requirePreparation: false,
    },
  });
  secondPlugin.register({ addTool() {} }, core);
  await secondPlugin.initialize({ core });
  t.after(() => secondPlugin.shutdown().catch(() => {}));

  const restoredWorker = secondPlugin.workers.get("device-a");
  const restored = restoredWorker.operations.get(queued.structuredContent.operationId);
  assert.equal(restored.state, "queued");
  assert.equal(restored.needsHeartbeat, true);
  await settle();
  assert.equal(state.sessions.length, 0);

  const heartbeat = await secondPlugin.executeTool("create", {
    action: "status",
    operationId: queued.structuredContent.operationId,
  });
  assert.equal(heartbeat.structuredContent.state, "queued");
  await settle(40);

  const ready = await secondPlugin.executeTool("create", {
    action: "status",
    operationId: queued.structuredContent.operationId,
  });
  assert.equal(ready.structuredContent.state, "ready");
  assert.equal(ready.structuredContent.sessionId, "session-after-restart");

  state.sessions = [];
  await secondPlugin.afterCall(
    { toolName: "appium_session_management", args: { action: "delete", sessionId: "session-after-restart" } },
    { isError: false, content: [] },
  );
});
