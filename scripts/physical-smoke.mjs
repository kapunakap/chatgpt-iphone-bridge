#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUrl = process.env.BRIDGE_FIXTURE_URL;
const fixtureSelector = process.env.BRIDGE_FIXTURE_SELECTOR ?? "#bridge-ready";
const fixtureMarker = process.env.BRIDGE_FIXTURE_MARKER ?? "BRIDGE_FIXTURE_READY";
if (!fixtureUrl) throw new Error("Set BRIDGE_FIXTURE_URL to the neutral fixture URL reachable from the iPhone");
const parsedFixtureUrl = new URL(fixtureUrl);
if (!new Set(["http:", "https:"]).has(parsedFixtureUrl.protocol)) {
  throw new Error("BRIDGE_FIXTURE_URL must use http or https");
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const launcher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");
const transport = new StdioClientTransport({
  command: launcher,
  cwd: repoRoot,
  env: { APPIUM_BRIDGE_ARTIFACT_ROOT: process.env.APPIUM_BRIDGE_ARTIFACT_ROOT ?? "" },
  stderr: "pipe",
});
const client = new Client({ name: "chatgpt-iphone-bridge-physical-smoke", version: "0.2.0-beta.1" });
let activeSessionId = null;
let activeOperation = null;

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

async function startAndPoll(name, args, deadlineMs) {
  const startedAt = Date.now();
  const startArgs = {
    action: "start",
    ...args,
    ...(name === "appium_create_session_async" ? { clientRequestId: `physical-smoke-${Date.now()}` } : {}),
  };
  const started = json(await call(name, startArgs, 5000), `${name} start`);
  if (!started.operationId || !new Set(["queued", "starting"]).has(started.state)) {
    throw new Error(`${name} did not enter the lifecycle`);
  }
  if (Date.now() - startedAt >= 2000) throw new Error(`${name} start exceeded two seconds`);
  activeOperation = { name, id: started.operationId };

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = json(
      await call(name, { action: "status", operationId: started.operationId }, 5000),
      `${name} status`,
    );
    if (status.state === "ready") {
      activeOperation = null;
      return status;
    }
    if (!new Set(["queued", "starting", "cancelling"]).has(status.state)) {
      throw new Error(`${name} ended in ${status.state}: ${JSON.stringify(status.error ?? {})}`);
    }
  }
  throw new Error(`${name} did not finish before its smoke-test deadline`);
}

try {
  await client.connect(transport);
  const selectArgs = {
    platform: "ios",
    iosDeviceType: "real",
    ...(process.env.IOS_DEVICE_UDID ? { deviceUdid: process.env.IOS_DEVICE_UDID } : {}),
  };
  const selected = json(await call("select_device", selectArgs, 60_000), "select_device");
  const udid = selected?.capabilities?.["appium:udid"];
  if (!udid) throw new Error("select_device did not select exactly one real iPhone");

  const discovery = await startAndPoll("appium_prepare_ios_real_device_async", { udid }, 60_000);
  const profileUuid =
    process.env.IOS_PROVISIONING_PROFILE_UUID ??
    discovery.result?.recommendedProfiles?.[0]?.uuid ??
    discovery.result?.recommendedProfiles?.[0]?.UUID;
  if (!profileUuid) throw new Error("No recommended WDA provisioning profile is available");

  const preparation = await startAndPoll(
    "appium_prepare_ios_real_device_async",
    { udid, provisioningProfileUuid: profileUuid },
    10 * 60_000,
  );
  const capabilities = {
    browserName: "Safari",
    ...preparation.result.capabilitiesHint,
    "appium:safariInitialUrl": fixtureUrl,
  };
  const creation = await startAndPoll(
    "appium_create_session_async",
    { capabilities: JSON.stringify(capabilities) },
    90_000,
  );
  activeSessionId = creation.sessionId;
  if (!activeSessionId) throw new Error("Safari session became ready without a session ID");

  const deviceInfo = json(
    await call("appium_mobile_device_info", { action: "info", sessionId: activeSessionId }),
    "device info",
  );
  if (deviceInfo.isSimulator !== false) throw new Error("Smoke session is not a physical iPhone");

  const contexts = text(await call("appium_context", { action: "list", sessionId: activeSessionId }));
  const webContext = contexts.match(/WEBVIEW_[^"\s,\]]+/)?.[0];
  if (!webContext) throw new Error(`No Safari web context became available: ${contexts}`);
  await call("appium_context", { action: "switch", context: webContext, sessionId: activeSessionId });
  let found = "";
  const markerDeadline = Date.now() + 20_000;
  while (Date.now() < markerDeadline) {
    try {
      found = text(
        await call("appium_find_element", {
          strategy: "css selector",
          selector: fixtureSelector,
          sessionId: activeSessionId,
        }),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const elementId = found.match(/^elementId '([^']+)'/)?.[1];
  if (!elementId) throw new Error("Neutral fixture marker was not found within 20 seconds");
  const marker = text(await call("appium_get_text", { elementUUID: elementId, sessionId: activeSessionId }));
  if (!marker.includes(fixtureMarker)) throw new Error(`Unexpected fixture marker: ${marker}`);
  await call("appium_screenshot", { sessionId: activeSessionId, maxWidth: 800 });

  await call("appium_session_management", { action: "delete", sessionId: activeSessionId }, 60_000);
  activeSessionId = null;
  const finalSessions = text(await call("appium_session_management", { action: "list" }));
  if (!/No active sessions found/i.test(finalSessions)) throw new Error(`Sessions remain: ${finalSessions}`);
  console.log("PHYSICAL_SMOKE_OK=1");
} finally {
  if (activeOperation) {
    await call(activeOperation.name, { action: "cancel", operationId: activeOperation.id }, 5000).catch(() => {});
  }
  if (activeSessionId) {
    await call("appium_session_management", { action: "delete", sessionId: activeSessionId }, 60_000).catch(() => {});
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
