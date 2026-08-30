import assert from "node:assert/strict";
import test from "node:test";

import { verifyAppiumMcpNames } from "appium-mcp/core";

import { IosSessionSafetyPlugin, PRIVILEGED_TOOLS } from "../src/ios-session-safety-plugin.mjs";

test("policy plugin adds no tools and does not collide", () => {
  const verification = verifyAppiumMcpNames({ plugins: [new IosSessionSafetyPlugin()] });
  assert.equal(verification.ok, true);
  assert.equal(verification.toolCount, 31);
});

test("safe mode only allows real iOS device selection", async () => {
  const plugin = new IosSessionSafetyPlugin();
  assert.equal(
    await plugin.beforeCall({ toolName: "select_device", args: { platform: "ios", iosDeviceType: "real" } }),
    undefined,
  );
  for (const args of [
    { platform: "ios", iosDeviceType: "simulator" },
    { platform: "android", androidDeviceType: "real" },
  ]) {
    assert.equal((await plugin.beforeCall({ toolName: "select_device", args })).isError, true);
  }
});

test("blocking, remote, and attached session paths fail closed", async () => {
  const plugin = new IosSessionSafetyPlugin();
  for (const args of [
    { action: "create", platform: "ios" },
    { action: "create", platform: "ios", remoteServerUrl: "http://127.0.0.1:4723" },
    { action: "attach", remoteServerUrl: "https://example.invalid", sessionId: "one" },
    { action: "detach", sessionId: "one" },
  ]) {
    assert.equal((await plugin.beforeCall({ toolName: "appium_session_management", args })).isError, true);
  }
  assert.equal(
    await plugin.beforeCall({ toolName: "appium_session_management", args: { action: "list" } }),
    undefined,
  );
});

test("blocking preparation points callers to the async tool", async () => {
  const result = await new IosSessionSafetyPlugin().beforeCall({
    toolName: "appium_prepare_ios_real_device",
    args: { udid: "placeholder" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /async/);
});

test("privileged tools require a local opt-in", async () => {
  const previous = process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS;
  delete process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS;
  try {
    const plugin = new IosSessionSafetyPlugin();
    for (const toolName of PRIVILEGED_TOOLS) {
      assert.equal((await plugin.beforeCall({ toolName, args: {} })).isError, true);
    }
    process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS = "appium_mobile_clipboard";
    assert.equal(await plugin.beforeCall({ toolName: "appium_mobile_clipboard", args: {} }), undefined);
    assert.equal((await plugin.beforeCall({ toolName: "appium_mobile_file", args: {} })).isError, true);
  } finally {
    if (previous === undefined) delete process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS;
    else process.env.APPIUM_BRIDGE_PRIVILEGED_TOOLS = previous;
  }
});
