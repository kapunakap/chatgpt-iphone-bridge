import assert from "node:assert/strict";
import test from "node:test";

import { verifyAppiumMcpNames } from "appium-mcp/core";

import { AsyncSessionPlugin } from "./async-session-plugin.mjs";

function setup(options = {}) {
  const state = { sessions: [], createArgs: null, deletes: [], acquired: 0, released: 0 };
  const core = {
    listSessions: () => state.sessions,
    getSessionId: () => state.sessions[0]?.sessionId ?? null,
  };
  const tools = new Map();
  const plugin = new AsyncSessionPlugin({
    makeId: () => "operation-1",
    prepareTimeoutMs: 100,
    createTimeoutMs: 100,
    cleanupTimeoutMs: 50,
    lease: {
      acquire: async () => {
        state.acquired += 1;
        return "lease-1";
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
      state.createArgs = args;
      state.sessions = [{ sessionId: "session-1", ownership: "owned" }];
      return { content: [{ type: "text", text: "created" }] };
    },
    deleteSession: async (sessionId) => {
      state.deletes.push(sessionId);
      state.sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
      return { content: [{ type: "text", text: "deleted" }] };
    },
    ...options,
  });
  plugin.register({ addTool: (tool) => tools.set(tool.name, tool) }, core);
  return { plugin, tools, state, core };
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

async function settle() {
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

test("async preparation caches only a ready matching WDA result", async () => {
  const { plugin, tools, state } = setup();
  await select(plugin);
  const started = await tools.get("appium_prepare_ios_real_device_async").execute({
    action: "start",
    udid: "selected-device",
    provisioningProfileUuid: "profile-1",
  });
  assert.equal(payload(started).state, "starting");
  await settle();
  const status = await tools.get("appium_prepare_ios_real_device_async").execute({ action: "status" });
  assert.equal(payload(status).state, "ready");
  assert.equal(payload(status).result.capabilitiesHint["appium:udid"], undefined);
  assert.equal(plugin.prepared.udid, "selected-device");
  assert.equal(state.released, 1);
});

test("async Safari creation injects the selected device and holds the lease until delete", async () => {
  const { plugin, tools, state } = setup();
  await select(plugin);
  plugin.prepared = {
    udid: "selected-device",
    capabilitiesHint: { "appium:prebuiltWDAPath": "/secure/WDA.ipa" },
  };
  const capabilities = {
    browserName: "Safari",
    "appium:usePreinstalledWDA": true,
    "appium:prebuiltWDAPath": "/secure/WDA.ipa",
    "appium:initialDeeplinkUrl": "https://example.test/",
  };
  const started = await tools.get("appium_create_session_async").execute({ action: "start", capabilities });
  assert.equal(payload(started).state, "starting");
  await settle();
  const ready = await tools.get("appium_create_session_async").execute({ action: "status" });
  assert.equal(payload(ready).state, "ready");
  assert.equal(payload(ready).sessionId, "session-1");
  assert.equal(state.createArgs.capabilities["appium:udid"], "selected-device");
  assert.equal(state.released, 0);

  state.sessions = [];
  await plugin.afterCall(
    { toolName: "appium_session_management", args: { action: "delete", sessionId: "session-1" } },
    { isError: false, content: [] },
  );
  assert.equal(plugin.operation.state, "closed");
  assert.equal(state.released, 1);
});

test("create rejects native, mismatched, unprepared, and unsafe URL capabilities", async () => {
  const { plugin, tools } = setup();
  await select(plugin);
  const create = tools.get("appium_create_session_async");
  for (const capabilities of [
    { browserName: "Safari", "appium:app": "/tmp/app.ipa" },
    { browserName: "Safari", "appium:udid": "other-device" },
    { browserName: "Safari", "appium:initialDeeplinkUrl": "file:///tmp/test" },
    null,
    [],
  ]) {
    const result = await create.execute({ action: "start", capabilities });
    assert.equal(result.isError, true);
  }
});

test("cancel while creating deletes a late-created session", async () => {
  let resolveCreate;
  const pending = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const { plugin, tools, state } = setup({ createSession: () => pending, requirePreparation: false });
  await select(plugin);
  await tools.get("appium_create_session_async").execute({
    action: "start",
    capabilities: { browserName: "Safari", "appium:usePreinstalledWDA": true },
  });
  const cancelling = await tools.get("appium_create_session_async").execute({ action: "cancel" });
  assert.equal(payload(cancelling).state, "cancelling");
  state.sessions = [{ sessionId: "late-session", ownership: "owned" }];
  resolveCreate({ content: [{ type: "text", text: "created late" }] });
  await settle();
  assert.deepEqual(state.deletes, ["late-session"]);
  assert.equal(plugin.operation.state, "cancelled");
  assert.equal(state.released, 1);
});

test("failed preparation never replaces a previous prepared result", async () => {
  const { plugin, tools } = setup({
    prepareDevice: async (args) => ({
      content: [{ type: "text", text: JSON.stringify({ mode: "build", ready: false, udid: args.udid }) }],
    }),
  });
  await select(plugin);
  plugin.prepared = { udid: "selected-device", capabilitiesHint: { "appium:prebuiltWDAPath": "/old.ipa" } };
  await tools.get("appium_prepare_ios_real_device_async").execute({
    action: "start",
    udid: "selected-device",
    provisioningProfileUuid: "profile-1",
  });
  await settle();
  assert.equal(plugin.operation.state, "failed");
  assert.equal(plugin.prepared.capabilitiesHint["appium:prebuiltWDAPath"], "/old.ipa");
});
