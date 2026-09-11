import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("installed Appium MCP contains the reviewed result and security patch", async () => {
  const root = path.dirname(require.resolve("appium-mcp/package.json"));
  const [plugin, createSession] = await Promise.all([
    fs.readFile(path.join(root, "dist/plugin.js"), "utf8"),
    fs.readFile(path.join(root, "dist/tools/session/create-session.js"), "utf8"),
  ]);
  assert.match(plugin, /runAfterHooks/);
  assert.match(plugin, /\.\.\.rawResult/);
  assert.match(plugin, /Plugin afterCall cleanup failed/);
  assert.match(createSession, /APPIUM_MCP_RELAXED_SECURITY === 'true'/);
  assert.match(createSession, /hasExplicitDeviceTarget/);
  assert.match(createSession, /!hasExplicitDeviceTarget && selectedLocalDevice/);
  assert.doesNotMatch(createSession, /session with capabilities/);
});

test("installed XCUITest legacy forwarding is loopback-only", async () => {
  const root = path.dirname(require.resolve("appium-xcuitest-driver/package.json"));
  const source = await fs.readFile(path.join(root, "build/lib/device/device-connections-factory.js"), "utf8");
  assert.match(source, /localServer\.listen\(this\.localport, '127\.0\.0\.1'\)/);
  assert.doesNotMatch(source, /localServer\.listen\(this\.localport\);/);
});
