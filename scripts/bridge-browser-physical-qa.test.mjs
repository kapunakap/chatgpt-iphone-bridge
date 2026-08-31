import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRIDGE_BROWSER_BUNDLE_ID,
  assertNoLeaseDirectories,
  assertBridgeBrowserCapabilities,
  bridgeBrowserCapabilities,
  makeDriveActions,
  makePressAndHoldActions,
  parseAccessibilityBounds,
  parseAttribute,
  parseElementId,
  retainedScreenshotPath,
  translateWebBounds,
  withUnconditionalCleanup,
} from "./bridge-browser-physical-qa.mjs";

test("physical QA capabilities hardcode Bridge Browser and preserve WDA preparation", () => {
  const capabilities = bridgeBrowserCapabilities({
    udid: "physical-iphone",
    preparationHint: { "appium:usePreinstalledWDA": true, "appium:wdaLaunchTimeout": 30_000 },
  });
  assert.equal(capabilities["appium:bundleId"], BRIDGE_BROWSER_BUNDLE_ID);
  assert.equal(capabilities["appium:udid"], "physical-iphone");
  assert.equal(capabilities["appium:noReset"], true);
  assert.equal(capabilities["appium:usePreinstalledWDA"], true);
});

test("physical QA refuses another app, Safari, and non-XCUITest sessions", () => {
  const valid = bridgeBrowserCapabilities({ udid: "physical-iphone" });
  assert.throws(() => assertBridgeBrowserCapabilities({ ...valid, "appium:bundleId": "com.apple.mobilesafari" }), /only permits/);
  assert.throws(() => assertBridgeBrowserCapabilities({ ...valid, browserName: "Safari" }), /refuses/);
  assert.throws(() => assertBridgeBrowserCapabilities({ ...valid, "appium:automationName": "Other" }), /XCUITest/);
});

test("press and hold uses real W3C touch down, timed pause, and touch up", () => {
  const [source] = makePressAndHoldActions({ x: 10, y: 20, durationMs: 1500 });
  assert.equal(source.parameters.pointerType, "touch");
  assert.deepEqual(source.actions.map(({ type }) => type), ["pointerMove", "pointerDown", "pause", "pointerUp"]);
  assert.equal(source.actions[2].duration, 1500);
  assert.throws(() => makePressAndHoldActions({ x: 10, y: 20, durationMs: 100 }), /250-10000ms/);
});

test("drive actions hold GAS and steer in parallel for the requested duration", () => {
  const actions = makeDriveActions({
    gas: { x: 300, y: 600, width: 60, height: 40 },
    stick: { x: 20, y: 550, width: 100, height: 100 },
    steer: -0.5,
    durationMs: 1800,
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].id, "gas");
  assert.equal(actions[0].actions[2].duration + actions[0].actions[3].duration, 1800);
  assert.equal(actions[1].id, "steering");
  assert.equal(actions[1].actions[3].duration, 1680);
});

test("MCP parser extracts element IDs and attributes without accepting missing values", () => {
  assert.equal(parseElementId("elementId 'abc-123'\nSuccessfully found"), "abc-123");
  assert.equal(parseElementId("missing"), null);
  assert.equal(parseAttribute('elementId \'abc\'\nAttribute "data-distance-m" of element abc: 123.5'), "123.5");
  assert.equal(parseAttribute('elementId \'abc\'\nAttribute "x" is not set on element abc'), null);
});

test("native WKWebView offset translates CSS bounds into physical screen coordinates", () => {
  const source = '<XCUIElementTypeOther name="bridge.webview" x="0" y="143" width="393" height="665">';
  const webView = parseAccessibilityBounds(source, "bridge.webview");
  assert.deepEqual(webView, { x: 0, y: 143, width: 393, height: 665 });
  assert.deepEqual(
    translateWebBounds({ x: 20, y: 30, width: 80, height: 40 }, webView),
    { x: 20, y: 173, width: 80, height: 40 },
  );
});

test("screenshots are retained under the run artifact root without path traversal", () => {
  assert.equal(
    retainedScreenshotPath("/private/tmp/qa-run", "route-008", "png"),
    "/private/tmp/qa-run/screenshots/route-008.png",
  );
  assert.throws(() => retainedScreenshotPath("/private/tmp/qa-run", "../escape", "png"), /label/);
});

test("cleanup gate rejects remaining lease directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-qa-test-"));
  await fs.mkdir(path.join(root, "runtime", "device-test.lock"), { recursive: true });
  await assert.rejects(assertNoLeaseDirectories(root), /device lease/);
  await fs.rm(root, { recursive: true, force: true });
});

test("unconditional cleanup runs after success, timeout, and cancellation", async () => {
  const events = [];
  const value = await withUnconditionalCleanup(async () => "ok", async () => events.push("success-cleanup"));
  assert.equal(value, "ok");
  await assert.rejects(
    withUnconditionalCleanup(async () => { throw new Error("timed out"); }, async () => events.push("failure-cleanup")),
    /timed out/,
  );
  await assert.rejects(
    withUnconditionalCleanup(async () => { throw new DOMException("cancelled", "AbortError"); }, async () => events.push("cancel-cleanup")),
    /cancelled/,
  );
  assert.deepEqual(events, ["success-cleanup", "failure-cleanup", "cancel-cleanup"]);
});
