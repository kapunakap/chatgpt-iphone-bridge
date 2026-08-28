import assert from "node:assert/strict";
import test from "node:test";

import { verifyAppiumMcpNames } from "appium-mcp/core";

import { IosSessionSafetyPlugin } from "./ios-session-safety-plugin.mjs";

function createContext(capabilities, overrides = {}) {
  return {
    toolName: "appium_session_management",
    args: {
      action: "create",
      platform: "ios",
      capabilities: JSON.stringify(capabilities),
      ...overrides.args,
    },
    session: { listSessions: () => [], ...overrides.session },
  };
}

test("plugin adds no tools and does not collide with Appium MCP", () => {
  const verification = verifyAppiumMcpNames({ plugins: [new IosSessionSafetyPlugin()] });
  assert.equal(verification.ok, true);
});

test("auto-selected real iPhone is injected into a later real-WDA create", async () => {
  const plugin = new IosSessionSafetyPlugin();
  await plugin.afterCall(
    { toolName: "select_device", args: { platform: "ios", iosDeviceType: "real" } },
    {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ capabilities: { "appium:udid": "selected-device" } }) }],
    },
  );

  const context = createContext({
    browserName: "Safari",
    "appium:usePreinstalledWDA": true,
    "appium:prebuiltWDAPath": "/runtime/WDA.ipa",
  });
  assert.equal(await plugin.beforeCall(context), undefined);
  assert.equal(JSON.parse(context.args.capabilities)["appium:udid"], "selected-device");
  assert.equal(JSON.parse(context.args.capabilities)["appium:deviceName"], "iPhone");
  await plugin.afterCall(context, { isError: false, content: [] });
  assert.equal(plugin.realIosUdid, "selected-device");
});

test("successful preparation is cached and an explicit create UDID is preserved", async () => {
  const plugin = new IosSessionSafetyPlugin();
  await plugin.afterCall(
    { toolName: "appium_prepare_ios_real_device", args: { udid: "prepared-device" } },
    { isError: false, content: [] },
  );
  assert.equal(plugin.realIosUdid, "prepared-device");

  const context = createContext({
    "appium:udid": "explicit-device",
    "appium:usePreinstalledWDA": true,
    "appium:prebuiltWDAPath": "/runtime/WDA.ipa",
  });
  await plugin.beforeCall(context);
  assert.equal(JSON.parse(context.args.capabilities)["appium:udid"], "explicit-device");
  await plugin.afterCall(context, { isError: false, content: [] });
  assert.equal(plugin.realIosUdid, "explicit-device");
});

test("failed preparation and failed explicit create do not replace the cached device", async () => {
  const plugin = new IosSessionSafetyPlugin();
  plugin.realIosUdid = "existing-device";
  await plugin.afterCall(
    { toolName: "appium_prepare_ios_real_device", args: { udid: "failed-preparation" } },
    { isError: true, content: [] },
  );
  assert.equal(plugin.realIosUdid, "existing-device");

  const context = createContext({
    "appium:udid": "failed-create",
    "appium:usePreinstalledWDA": true,
  });
  await plugin.beforeCall(context);
  await plugin.afterCall(context, { isError: true, content: [] });
  assert.equal(plugin.realIosUdid, "existing-device");
});

test("simulator creates stay unchanged and ambiguous real-WDA creates fail closed", async () => {
  const plugin = new IosSessionSafetyPlugin();
  const simulatorContext = createContext({ browserName: "Safari" });
  await plugin.beforeCall(simulatorContext);
  assert.deepEqual(JSON.parse(simulatorContext.args.capabilities), { browserName: "Safari" });
  await plugin.afterCall(simulatorContext, { isError: false, content: [] });

  const realContext = createContext({ "appium:usePreinstalledWDA": true });
  const rejected = await plugin.beforeCall(realContext);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /requires a selected iPhone/);
});

test("selecting a non-real target clears the runtime real-device pin", async () => {
  const plugin = new IosSessionSafetyPlugin();
  plugin.realIosUdid = "old-device";
  await plugin.beforeCall({
    toolName: "select_device",
    args: { platform: "ios", iosDeviceType: "simulator" },
  });
  assert.equal(plugin.realIosUdid, null);
});

test("concurrent and duplicate owned session creation are rejected", async () => {
  const plugin = new IosSessionSafetyPlugin();
  const first = createContext({}, { args: { platform: "android" } });
  assert.equal(await plugin.beforeCall(first), undefined);

  const concurrent = await plugin.beforeCall(createContext({}, { args: { platform: "android" } }));
  assert.equal(concurrent.isError, true);
  assert.match(concurrent.content[0].text, /creation is already in progress/);
  await plugin.afterCall(first, { isError: false, content: [] });

  const duplicate = await plugin.beforeCall(
    createContext({}, { session: { listSessions: () => [{ ownership: "owned", sessionId: "active-session" }] } }),
  );
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already active/);
});
