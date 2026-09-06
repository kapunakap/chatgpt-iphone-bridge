#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chooseReachableFixture } from "../src/fixture-preflight.mjs";

const udids = String(process.env.IOS_DEVICE_UDIDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (udids.length !== 2 || new Set(udids).size !== 2) {
  throw new Error("Set IOS_DEVICE_UDIDS to exactly two distinct comma-separated physical iOS UDIDs");
}

const primaryFixtureUrl = process.env.BRIDGE_FIXTURE_URL;
if (!primaryFixtureUrl) throw new Error("Set BRIDGE_FIXTURE_URL to a neutral page reachable from both iOS devices");
const fallbackUrl = process.env.BRIDGE_FIXTURE_FALLBACK_URL;
if (fallbackUrl && (!process.env.BRIDGE_FIXTURE_FALLBACK_SELECTOR || !process.env.BRIDGE_FIXTURE_FALLBACK_MARKER)) {
  throw new Error("Fallback URL requires BRIDGE_FIXTURE_FALLBACK_SELECTOR and BRIDGE_FIXTURE_FALLBACK_MARKER");
}
const selectedFixture = await chooseReachableFixture(
  {
    url: primaryFixtureUrl,
    selector: process.env.BRIDGE_FIXTURE_SELECTOR ?? "#bridge-ready",
    marker: process.env.BRIDGE_FIXTURE_MARKER ?? "BRIDGE_FIXTURE_READY",
  },
  fallbackUrl
    ? {
        url: fallbackUrl,
        selector: process.env.BRIDGE_FIXTURE_FALLBACK_SELECTOR,
        marker: process.env.BRIDGE_FIXTURE_FALLBACK_MARKER,
      }
    : null,
);
const fixture = selectedFixture.fixture;
console.log(`fixture_source=${selectedFixture.source}`);

const explicitProfiles = String(process.env.IOS_PROVISIONING_PROFILE_UUIDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (explicitProfiles.length > 0 && explicitProfiles.length !== 2) {
  throw new Error("IOS_PROVISIONING_PROFILE_UUIDS must contain exactly two comma-separated UUIDs when set");
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const launcher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");
const transportEnvironment = process.env.APPIUM_BRIDGE_ARTIFACT_ROOT
  ? { APPIUM_BRIDGE_ARTIFACT_ROOT: process.env.APPIUM_BRIDGE_ARTIFACT_ROOT }
  : undefined;
const transport = new StdioClientTransport({
  command: launcher,
  cwd: repoRoot,
  ...(transportEnvironment ? { env: transportEnvironment } : {}),
  stderr: "pipe",
});
const client = new Client({ name: "chatgpt-iphone-bridge-pool-physical-smoke", version: "0.2.0-beta.3" });
const activeOperations = new Map();
const activeSessions = new Set();

function text(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function json(result, label) {
  try {
    return result?.structuredContent ?? JSON.parse(text(result));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function call(name, args, timeout = 30_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (result?.isError) throw new Error(`${name}: ${text(result)}`);
  return result;
}

async function start(name, args) {
  const startedAt = Date.now();
  const started = json(await call(name, { action: "start", ...args }, 5_000), `${name} start`);
  if (!started.operationId || !new Set(["queued", "starting"]).has(started.state)) {
    throw new Error(`${name} did not enter the lifecycle`);
  }
  if (Date.now() - startedAt >= 2_000) throw new Error(`${name} start exceeded two seconds`);
  activeOperations.set(started.operationId, name);
  return started;
}

async function poll(name, operationId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = json(await call(name, { action: "status", operationId }, 5_000), `${name} status`);
    if (status.state === "ready") {
      activeOperations.delete(operationId);
      return status;
    }
    if (!new Set(["queued", "starting", "cancelling"]).has(status.state)) {
      throw new Error(`${name} ended in ${status.state}: ${JSON.stringify(status.error ?? {})}`);
    }
  }
  throw new Error(`${name} did not finish before its physical acceptance deadline`);
}

async function startAndPoll(name, args, deadlineMs) {
  const started = await start(name, args);
  return await poll(name, started.operationId, deadlineMs);
}

async function prepareDevice(udid, index) {
  const discovery = await startAndPoll("appium_prepare_ios_real_device_async", { udid }, 60_000);
  const profileUuid =
    explicitProfiles[index] ??
    process.env.IOS_PROVISIONING_PROFILE_UUID ??
    discovery.result?.recommendedProfiles?.[0]?.uuid ??
    discovery.result?.recommendedProfiles?.[0]?.UUID;
  if (!profileUuid) throw new Error(`No recommended WDA provisioning profile is available for device ${index + 1}`);
  const preparation = await startAndPoll(
    "appium_prepare_ios_real_device_async",
    { udid, provisioningProfileUuid: profileUuid },
    10 * 60_000,
  );
  if (!preparation.result?.capabilitiesHint?.["appium:prebuiltWDAPath"]) {
    throw new Error(`Preparation for device ${index + 1} did not return a prebuilt WDA path`);
  }
  return preparation.result.capabilitiesHint;
}

async function verifySession(sessionId, index) {
  const deviceInfo = json(
    await call("appium_mobile_device_info", { action: "info", sessionId }, 30_000),
    `device ${index + 1} info`,
  );
  if (deviceInfo.isSimulator !== false) throw new Error(`Pool session ${index + 1} is not a physical iOS device`);

  const contexts = text(await call("appium_context", { action: "list", sessionId }));
  const webContext = contexts.match(/WEBVIEW_[^"\s,\]]+/)?.[0];
  if (!webContext) throw new Error(`No Safari web context became available for pool session ${index + 1}`);
  await call("appium_context", { action: "switch", context: webContext, sessionId });

  let elementId = null;
  const deadline = Date.now() + 20_000;
  while (!elementId && Date.now() < deadline) {
    try {
      const found = text(
        await call("appium_find_element", {
          strategy: "css selector",
          selector: fixture.selector,
          sessionId,
        }),
      );
      elementId = found.match(/^elementId '([^']+)'/)?.[1] ?? null;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!elementId) throw new Error(`Neutral fixture marker was not found on pool session ${index + 1}`);
  const marker = text(await call("appium_get_text", { elementUUID: elementId, sessionId }));
  if (!marker.includes(fixture.marker)) throw new Error(`Unexpected fixture marker on pool session ${index + 1}`);
  await call("appium_screenshot", { sessionId, maxWidth: 800 });
}

try {
  await client.connect(transport);

  for (const udid of udids) {
    const selected = json(
      await call("select_device", { platform: "ios", iosDeviceType: "real", deviceUdid: udid }, 60_000),
      "select_device",
    );
    if (selected?.capabilities?.["appium:udid"] !== udid) {
      throw new Error("select_device did not preserve the explicit physical iOS target");
    }
  }

  const hints = [];
  for (const [index, udid] of udids.entries()) {
    hints.push(await prepareDevice(udid, index));
  }

  const starts = await Promise.all(
    udids.map((udid, index) =>
      start("appium_create_session_async", {
        udid,
        clientRequestId: `pool-physical-${index + 1}-${Date.now()}`,
        capabilities: JSON.stringify({
          browserName: "Safari",
          ...hints[index],
          "appium:safariInitialUrl": fixture.url,
        }),
      }),
    ),
  );

  const creations = await Promise.all(
    starts.map((started) => poll("appium_create_session_async", started.operationId, 150_000)),
  );
  for (const [index, creation] of creations.entries()) {
    if (!creation.sessionId) throw new Error(`Pool session ${index + 1} became ready without a session ID`);
    activeSessions.add(creation.sessionId);
  }
  if (activeSessions.size !== 2) throw new Error("Two distinct Safari sessions were not active concurrently");
  console.log("concurrent_sessions=2");

  await Promise.all([...activeSessions].map((sessionId, index) => verifySession(sessionId, index)));

  for (const sessionId of [...activeSessions]) {
    await call("appium_session_management", { action: "delete", sessionId }, 60_000);
    activeSessions.delete(sessionId);
  }
  const finalSessions = text(await call("appium_session_management", { action: "list" }));
  if (!/No active sessions found/i.test(finalSessions)) throw new Error(`Sessions remain: ${finalSessions}`);
  console.log("POOL_PHYSICAL_SMOKE_OK=1");
} finally {
  for (const [operationId, name] of activeOperations) {
    await call(name, { action: "cancel", operationId }, 5_000).catch(() => {});
  }
  for (const sessionId of activeSessions) {
    await call("appium_session_management", { action: "delete", sessionId }, 60_000).catch(() => {});
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
