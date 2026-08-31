#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BRIDGE_BROWSER_BUNDLE_ID = "com.kapunakap.chatgptiphonebridge.BridgeBrowser";
export const GTA_LABIN_URL = "https://kapunakap.github.io/gta-labin/?multiplayer=1";
export const GTA_LABIN_DRIVE_URL = "https://kapunakap.github.io/gta-labin/";
export const GTA_LABIN_ORIGIN = "https://kapunakap.github.io";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_HOLD_MS = 250;
export const MAX_HOLD_MS = 10_000;

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function bridgeBrowserCapabilities({ udid, preparationHint = {} }) {
  if (typeof udid !== "string" || udid.trim() === "") throw new Error("A physical iPhone UDID is required");
  const capabilities = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": "iPhone",
    "appium:udid": udid,
    "appium:bundleId": BRIDGE_BROWSER_BUNDLE_ID,
    "appium:noReset": true,
    "appium:forceAppLaunch": true,
    ...preparationHint,
  };
  assertBridgeBrowserCapabilities(capabilities);
  return capabilities;
}

export function assertBridgeBrowserCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("Bridge Browser capabilities must be an object");
  }
  if (capabilities["appium:bundleId"] !== BRIDGE_BROWSER_BUNDLE_ID) {
    throw new Error(`Physical QA only permits ${BRIDGE_BROWSER_BUNDLE_ID}`);
  }
  if (capabilities["appium:app"] || capabilities.browserName) {
    throw new Error("Physical QA refuses other native apps and browser sessions");
  }
  if (capabilities.platformName !== "iOS" || capabilities["appium:automationName"] !== "XCUITest") {
    throw new Error("Physical QA requires iOS XCUITest");
  }
  return capabilities;
}

export function makePressAndHoldActions({ x, y, durationMs, id = "hold" }) {
  if (!Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0) {
    throw new Error("Touch coordinates must be non-negative integers");
  }
  if (!Number.isInteger(durationMs) || durationMs < MIN_HOLD_MS || durationMs > MAX_HOLD_MS) {
    throw new Error(`Touch hold must be ${MIN_HOLD_MS}-${MAX_HOLD_MS}ms`);
  }
  return [
    {
      type: "pointer",
      id,
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x, y, origin: "viewport" },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: durationMs },
        { type: "pointerUp", button: 0 },
      ],
    },
  ];
}

export function makeDriveActions({ gas, pedal = gas, pedalId = "gas", stick, steer, durationMs = 1800 }) {
  if (!pedal || !stick) throw new Error("Pedal and steering bounds are required");
  if (!Number.isFinite(steer) || steer < -1 || steer > 1) throw new Error("Steering must be between -1 and 1");
  if (!Number.isInteger(durationMs) || durationMs < MIN_HOLD_MS || durationMs > MAX_HOLD_MS) {
    throw new Error(`Drive action must be ${MIN_HOLD_MS}-${MAX_HOLD_MS}ms`);
  }
  const gasX = Math.round(pedal.x + pedal.width / 2);
  const gasY = Math.round(pedal.y + pedal.height / 2);
  const stickX = Math.round(stick.x + stick.width / 2);
  const stickY = Math.round(stick.y + stick.height / 2);
  const targetX = Math.round(stickX + steer * stick.width * 0.4);
  return [
    {
      type: "pointer",
      id: pedalId,
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: gasX, y: gasY, origin: "viewport" },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 120 },
        { type: "pause", duration: Math.max(0, durationMs - 120) },
        { type: "pointerUp", button: 0 },
      ],
    },
    {
      type: "pointer",
      id: "steering",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: stickX, y: stickY, origin: "viewport" },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 120, x: targetX, y: stickY, origin: "viewport" },
        { type: "pause", duration: Math.max(0, durationMs - 120) },
        { type: "pointerUp", button: 0 },
      ],
    },
  ];
}

export function parseElementId(resultText) {
  return resultText.match(/^elementId '([^']+)'/)?.[1] ?? null;
}

export function parseAttribute(resultText) {
  const match = resultText.match(/: ([^\n]*)$/m);
  return match?.[1] ?? null;
}

export function parseAccessibilityBounds(pageSource, accessibilityId) {
  const escaped = accessibilityId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const element = pageSource.match(new RegExp(`<[^>]+name="${escaped}"[^>]*>`))?.[0];
  if (!element) return null;
  const value = (name) => Number(element.match(new RegExp(`\\s${name}="([0-9.]+)"`))?.[1]);
  const bounds = { x: value("x"), y: value("y"), width: value("width"), height: value("height") };
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

export function translateWebBounds(bounds, webViewBounds) {
  return {
    x: bounds.x + webViewBounds.x,
    y: bounds.y + webViewBounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function retainedScreenshotPath(artifactRoot, label, extension) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(label)) throw new Error("Screenshot label is invalid");
  if (!new Set(["png", "jpg"]).has(extension)) throw new Error("Screenshot extension is invalid");
  return path.join(path.resolve(artifactRoot), "screenshots", `${label}.${extension}`);
}

export async function assertNoLeaseDirectories(artifactRoot) {
  const runtimeRoot = path.join(artifactRoot, "runtime");
  const entries = await fs.readdir(runtimeRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const leases = entries.filter((entry) => entry.name.endsWith(".lock"));
  if (leases.length > 0) throw new Error(`Physical QA cleanup left ${leases.length} device lease(s)`);
}

export async function withUnconditionalCleanup(run, cleanup) {
  let thrown;
  try {
    return await run();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!thrown) throw cleanupError;
    }
  }
}

function resultText(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function resultJson(result, label) {
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(resultText(result));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Physical QA cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function assertManagedTunnelStopped() {
  try {
    const { stdout } = await execFile("tunnel-client", ["runtimes", "--json", "status", "local-iphone-bridge"], {
      timeout: 15_000,
    });
    const status = JSON.parse(stdout);
    if (status.process_running === true) {
      throw new Error("Stop managed runtime local-iphone-bridge before physical QA");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof SyntaxError) throw new Error("Could not verify that the managed runtime is stopped");
    throw error;
  }
}

function parseArgs(argv) {
  const options = { diagnoseOnly: false, pairOnly: false, routeTimeoutMs: 12 * 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--diagnose-only") options.diagnoseOnly = true;
    else if (value === "--pair-only") options.pairOnly = true;
    else if (value === "--route-timeout-ms") options.routeTimeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isFinite(options.routeTimeoutMs) || options.routeTimeoutMs < 60_000) {
    throw new Error("--route-timeout-ms must be at least 60000");
  }
  return options;
}

async function runPhysicalQa(options) {
  await assertManagedTunnelStopped();
  const relayUrl = process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL;
  const identityFile = process.env.IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE;
  if (!options.pairOnly && (!relayUrl || !identityFile)) {
    throw new Error("Set IPHONE_BRIDGE_CELLULAR_RELAY_URL and IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE");
  }
  if (relayUrl && new URL(relayUrl).protocol !== "https:") throw new Error("Cellular relay URL must use HTTPS");
  const pairingPayload = options.pairOnly ? process.env.BRIDGE_BROWSER_QA_PAIRING_PAYLOAD : null;
  if (options.pairOnly) {
    if (!pairingPayload) throw new Error("Set BRIDGE_BROWSER_QA_PAIRING_PAYLOAD for --pair-only");
    const parsed = JSON.parse(pairingPayload);
    if (parsed.version !== 1 || typeof parsed.deviceId !== "string" || Number(parsed.expiresAt) <= Date.now()) {
      throw new Error("BRIDGE_BROWSER_QA_PAIRING_PAYLOAD is invalid or expired");
    }
  }

  const runName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const artifactRoot = path.resolve(process.env.BRIDGE_BROWSER_QA_ARTIFACT_ROOT ?? path.join(repoRoot, "artifacts", "bridge-browser-physical-qa", runName));
  await fs.mkdir(path.join(artifactRoot, "screenshots"), { recursive: true, mode: 0o700 });
  const launcher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");
  const transport = new StdioClientTransport({
    command: launcher,
    cwd: repoRoot,
    env: {
      ...process.env,
      APPIUM_BRIDGE_ARTIFACT_ROOT: artifactRoot,
      APPIUM_BRIDGE_UNSAFE_FULL_APPIUM: "true",
      IPHONE_BRIDGE_CELLULAR_ENABLED: options.pairOnly ? "false" : "true",
      ...(relayUrl ? { IPHONE_BRIDGE_CELLULAR_RELAY_URL: relayUrl } : {}),
      ...(identityFile ? { IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE: identityFile } : {}),
      IPHONE_BRIDGE_CELLULAR_DEVICE_ALIAS: process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_ALIAS ?? "physical-qa-iphone",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "bridge-browser-physical-qa", version: "0.2.0-beta.3" });
  const abortController = new AbortController();
  let nativeSessionId = null;
  let cellularOperationId = null;
  let cellularSessionId = null;
  let clientConnected = false;
  let serverStderr = "";
  transport.stderr?.setEncoding?.("utf8");
  transport.stderr?.on?.("data", (chunk) => {
    serverStderr += chunk;
    if (serverStderr.length > 64_000) serverStderr = serverStderr.slice(-64_000);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => abortController.abort(new Error(`Received ${signal}`)));
  }

  const call = async (name, args, timeout = DEFAULT_TIMEOUT_MS) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout,
      signal: abortController.signal,
    });
    if (result?.isError) throw new Error(`${name}: ${resultText(result)}`);
    return result;
  };
  const captureNative = async (label) => {
    const result = await call("appium_screenshot", { sessionId: nativeSessionId, maxWidth: 1200 }, 60_000);
    const source = resultText(result).match(/Screenshot saved successfully to: (.+)$/m)?.[1];
    if (!source) throw new Error("Native screenshot path was not returned");
    const target = retainedScreenshotPath(artifactRoot, label, "png");
    if (path.resolve(source) !== path.resolve(target)) await fs.copyFile(source, target);
    return target;
  };
  const captureCellular = async (label) => {
    const result = await call("iphone_browser_screenshot", { sessionId: cellularSessionId, maxWidth: 1200 }, 60_000);
    const image = result.content?.find((item) => item.type === "image");
    if (!image?.data) throw new Error("Cellular screenshot image was not returned");
    const target = retainedScreenshotPath(artifactRoot, label, "jpg");
    await fs.writeFile(target, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return target;
  };
  const findNative = async (selector, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const found = await call("appium_find_element", {
          strategy: "accessibility id",
          selector,
          sessionId: nativeSessionId,
        });
        const id = parseElementId(resultText(found));
        if (id) return id;
      } catch (error) {
        lastError = error;
      }
      await sleep(500, abortController.signal);
    }
    throw new Error(`Native element was not found: ${selector}. ${lastError?.message ?? ""}`.trim());
  };
  const nativeText = async (selector) => {
    const id = await findNative(selector);
    return resultText(await call("appium_get_text", { elementUUID: id, sessionId: nativeSessionId }));
  };
  const tapNative = async (selector) => {
    const id = await findNative(selector);
    await call("appium_gesture", { action: "tap", elementUUID: id, sessionId: nativeSessionId });
  };
  const waitDeviceReady = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let status;
    while (Date.now() < deadline) {
      status = resultJson(await call("iphone_browser_device_status", {}), "device status");
      if (status.hostOnline && status.deviceOnline && status.secureReady) return status;
      await sleep(500, abortController.signal);
    }
    return status;
  };
  const cellularFind = async (selector, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const payload = resultJson(
        await call("iphone_browser_find", { sessionId: cellularSessionId, strategy: "css", selector, limit: 1 }),
        `find ${selector}`,
      );
      const element = payload.elements?.[0];
      if (element) return element;
      await sleep(250, abortController.signal);
    }
    throw new Error(`Cellular element not found: ${selector}`);
  };

  await withUnconditionalCleanup(
    async () => {
      await client.connect(transport);
      clientConnected = true;
      const selected = resultJson(
        await call("select_device", {
          platform: "ios",
          iosDeviceType: "real",
          ...(process.env.IOS_DEVICE_UDID ? { deviceUdid: process.env.IOS_DEVICE_UDID } : {}),
        }, 60_000),
        "select_device",
      );
      const udid = selected?.capabilities?.["appium:udid"];
      if (!udid) throw new Error("select_device did not select exactly one physical iPhone");

      const discovery = resultJson(
        await call("appium_prepare_ios_real_device", { udid }, 60_000),
        "WDA profile discovery",
      );
      const profileUuid =
        process.env.IOS_PROVISIONING_PROFILE_UUID ??
        discovery.recommendedProfiles?.[0]?.uuid ??
        discovery.recommendedProfiles?.[0]?.UUID;
      if (!profileUuid) throw new Error("No recommended WDA provisioning profile is available");
      const preparation = resultJson(
        await call("appium_prepare_ios_real_device", { udid, provisioningProfileUuid: profileUuid }, 10 * 60_000),
        "WDA preparation",
      );
      if (!preparation.ready) throw new Error(`WDA preparation failed: ${JSON.stringify(preparation)}`);

      const capabilities = bridgeBrowserCapabilities({ udid, preparationHint: preparation.capabilitiesHint });
      await call("appium_session_management", {
        action: "create",
        platform: "ios",
        capabilities: JSON.stringify(capabilities),
      }, 180_000);
      const sessions = resultText(await call("appium_session_management", { action: "list" }));
      nativeSessionId = sessions.match(/sessionId=([^\s]+)/)?.[1] ?? null;
      if (!nativeSessionId) throw new Error("Bridge Browser native session was not created");
      await captureNative("01-native-launch");

      if (options.pairOnly) {
        const field = await findNative("bridge.pairing-payload");
        await call("appium_set_value", {
          elementUUID: field,
          text: pairingPayload,
          sessionId: nativeSessionId,
        });
        await tapNative("bridge.pair");
        const pairDeadline = Date.now() + 30_000;
        let paired = false;
        while (Date.now() < pairDeadline) {
          const value = await nativeText("bridge.status").catch(() => "");
          if (/Paired|Connecting|Secure channel/i.test(value) && !/Not paired/i.test(value)) {
            paired = true;
            break;
          }
          const error = await nativeText("bridge.error").catch(() => "");
          if (error) throw new Error(`Bridge Browser pairing failed: ${error.split("\n").at(-1)}`);
          await sleep(500, abortController.signal);
        }
        if (!paired) throw new Error("Bridge Browser did not accept the pairing payload within 30 seconds");
        await captureNative("02-paired");
        console.log(`BRIDGE_BROWSER_PAIRING_SUBMITTED=1 artifact_root=${artifactRoot}`);
        return;
      }

      const statusLabel = await nativeText("bridge.status").catch(() => "bridge.status unavailable");
      const errorLabel = await nativeText("bridge.error").catch(() => "");
      console.log(`native_status=${statusLabel.split("\n").at(-1)}`);
      if (errorLabel) console.log(`native_error=${errorLabel.split("\n").at(-1)}`);
      const readiness = await waitDeviceReady();
      console.log(`relay_ready=${Boolean(readiness?.hostOnline && readiness?.deviceOnline && readiness?.secureReady)}`);
      if (!readiness?.hostOnline || !readiness?.deviceOnline || !readiness?.secureReady) {
        await captureNative("02-relay-not-ready");
        throw new Error(`Relay readiness gate failed: ${JSON.stringify(readiness)}`);
      }
      if (options.diagnoseOnly) {
        console.log(`BRIDGE_BROWSER_PHYSICAL_DIAG_OK=1 artifact_root=${artifactRoot}`);
        return;
      }

      const started = resultJson(
        await call("iphone_browser_session", {
          action: "start",
          initialUrl: GTA_LABIN_URL,
          allowedOrigins: [GTA_LABIN_ORIGIN],
        }),
        "cellular session start",
      );
      cellularOperationId = started.operationId;
      if (!cellularOperationId) throw new Error("Cellular session operation did not start");
      const approvalVisibleDeadline = Date.now() + 15_000;
      while (Date.now() < approvalVisibleDeadline) {
        const status = resultJson(
          await call("iphone_browser_session", { action: "status", operationId: cellularOperationId }),
          "cellular approval status",
        );
        if (status.state === "awaiting_approval") break;
        if (!new Set(["awaiting_device", "requesting_approval", "awaiting_approval"]).has(status.state)) {
          throw new Error(`Cellular session ended before approval in ${status.state}`);
        }
        await sleep(250, abortController.signal);
      }
      await sleep(500, abortController.signal);
      await captureNative("02-approval-request");
      console.log(`approval_native_status=${(await nativeText("bridge.status").catch(() => "unavailable")).split("\n").at(-1)}`);
      try {
        await tapNative("bridge.approve");
      } catch (error) {
        const source = resultText(await call("appium_get_page_source", { sessionId: nativeSessionId }, 60_000).catch(() => null));
        if (source) await fs.writeFile(path.join(artifactRoot, "approval-page-source.txt"), source, { mode: 0o600 });
        throw error;
      }
      const approvalDeadline = Date.now() + 60_000;
      while (Date.now() < approvalDeadline) {
        const status = resultJson(
          await call("iphone_browser_session", { action: "status", operationId: cellularOperationId }),
          "cellular session status",
        );
        if (status.state === "ready") {
          cellularSessionId = status.sessionId;
          break;
        }
        if (!new Set(["awaiting_approval", "requesting_approval", "awaiting_device"]).has(status.state)) {
          throw new Error(`Cellular session ended in ${status.state}: ${JSON.stringify(status.error ?? {})}`);
        }
        await sleep(500, abortController.signal);
      }
      if (!cellularSessionId) throw new Error("Cellular session was not approved within 60 seconds");

      const activeNativeSource = resultText(
        await call("appium_get_page_source", { sessionId: nativeSessionId }, 60_000),
      );
      const webViewBounds = parseAccessibilityBounds(activeNativeSource, "bridge.webview");
      if (!webViewBounds) throw new Error("Bridge Browser WKWebView bounds are unavailable from native accessibility");
      console.log(`webview_origin=${webViewBounds.x},${webViewBounds.y}`);

      let renderer;
      const renderDeadline = Date.now() + 90_000;
      while (Date.now() < renderDeadline) {
        renderer = await cellularFind("#renderer-status").catch(() => null);
        if (renderer && !/BOOTING/i.test(renderer.text ?? "")) break;
        await sleep(1000, abortController.signal);
      }
      if (!renderer) throw new Error("GTA Labin renderer status did not render");
      if (/BOOTING/i.test(renderer.text ?? "")) throw new Error("GTA Labin remained in BOOTING state for 90 seconds");
      console.log(`renderer_status=${renderer.text}`);
      await captureCellular("03-gta-rendered");

      const create = await cellularFind("[data-multiplayer-create]", 10_000);
      const createBounds = translateWebBounds(create.bounds, webViewBounds);
      console.log("stage=create-touch");
      await call("appium_perform_actions", {
        sessionId: nativeSessionId,
        actions: makePressAndHoldActions({
          x: Math.round(createBounds.x + createBounds.width / 2),
          y: Math.round(createBounds.y + createBounds.height / 2),
          durationMs: 300,
          id: "create",
        }),
      }, 60_000);
      console.log("stage=create-reload");
      await cellularFind("[data-touch-action=context]", 90_000);
      const postCreate = resultJson(
        await call("iphone_browser_snapshot", { sessionId: cellularSessionId, maxNodes: 50 }),
        "post-create snapshot",
      );
      if (!new URL(postCreate.url).searchParams.has("room")) throw new Error("CREATE touch did not create a room URL");
      let postCreateRenderer;
      const postCreateRenderDeadline = Date.now() + 90_000;
      while (Date.now() < postCreateRenderDeadline) {
        postCreateRenderer = await cellularFind("#renderer-status", 1000).catch(() => null);
        if (postCreateRenderer && !/BOOTING/i.test(postCreateRenderer.text ?? "")) break;
        await sleep(1000, abortController.signal);
      }
      if (!postCreateRenderer || /BOOTING/i.test(postCreateRenderer.text ?? "")) {
        throw new Error("GTA Labin did not finish rendering after CREATE navigation");
      }
      console.log("stage=create-complete");
      await captureCellular("04-room-created");

      await call("iphone_browser_navigate", {
        sessionId: cellularSessionId,
        action: "open",
        url: GTA_LABIN_DRIVE_URL,
      });
      let driveRenderer;
      const driveRenderDeadline = Date.now() + 90_000;
      while (Date.now() < driveRenderDeadline) {
        driveRenderer = await cellularFind("#renderer-status", 1000).catch(() => null);
        if (driveRenderer && !/BOOTING/i.test(driveRenderer.text ?? "")) break;
        await sleep(1000, abortController.signal);
      }
      if (!driveRenderer || /BOOTING/i.test(driveRenderer.text ?? "")) {
        throw new Error("GTA Labin did not finish rendering for the clean drive page");
      }
      await captureCellular("05-drive-ready");

      let entered = false;
      for (let attempt = 1; attempt <= 3 && !entered; attempt += 1) {
        const contextButton = await cellularFind("[data-touch-action=context]", 20_000);
        const contextBounds = translateWebBounds(contextButton.bounds, webViewBounds);
        const contextX = Math.round(contextBounds.x + contextBounds.width / 2);
        const contextY = Math.round(contextBounds.y + contextBounds.height / 2);
        await call("appium_perform_actions", {
          sessionId: nativeSessionId,
          actions: makePressAndHoldActions({ x: contextX, y: contextY, durationMs: 300, id: `enter-${attempt}` }),
        });
        await sleep(1200, abortController.signal);
        const nextContext = await cellularFind("[data-touch-action=context]", 3000).catch(() => null);
        entered = /EXIT/i.test(nextContext?.text ?? "");
      }
      if (!entered) throw new Error("ENTER touch did not put the player in the vehicle");
      await captureCellular("06-vehicle-entered");

      console.log("stage=webview-context-list");
      const contextsText = resultText(await call("appium_context", { action: "list", sessionId: nativeSessionId }, 60_000));
      const webContext = contextsText.match(/WEBVIEW_[^"\s,\]]+/)?.[0];
      if (!webContext) throw new Error(`Debug WKWebView context is unavailable: ${contextsText}`);
      console.log("stage=webview-context-switch");
      await call("appium_context", { action: "switch", context: webContext, sessionId: nativeSessionId }, 60_000);

      const objectiveFound = await call("appium_find_element", {
        strategy: "css selector",
        selector: "#objective",
        sessionId: nativeSessionId,
      });
      const objectiveId = parseElementId(resultText(objectiveFound));
      if (!objectiveId) throw new Error("Objective DOM element was not available in the WKWebView context");

      const gas = translateWebBounds((await cellularFind("[data-touch-action=gas]")).bounds, webViewBounds);
      const brake = translateWebBounds((await cellularFind("[data-touch-action=brake]")).bounds, webViewBounds);
      const stick = translateWebBounds((await cellularFind("[data-touch-stick]")).bounds, webViewBounds);
      const checkpointFile = path.join(artifactRoot, "route-checkpoints.json");
      const checkpoints = [];
      const routeDeadline = Date.now() + options.routeTimeoutMs;
      let lastDistance = Number.POSITIVE_INFINITY;
      let noProgress = 0;
      let recoveries = 0;
      while (Date.now() < routeDeadline) {
        const distanceText = resultText(await call("appium_get_element_attribute", {
          elementUUID: objectiveId,
          attribute: "data-distance-m",
          sessionId: nativeSessionId,
        }));
        const completeText = resultText(await call("appium_get_element_attribute", {
          elementUUID: objectiveId,
          attribute: "data-complete",
          sessionId: nativeSessionId,
        }));
        const bearingText = resultText(await call("appium_get_element_attribute", {
          elementUUID: objectiveId,
          attribute: "data-bearing-rad",
          sessionId: nativeSessionId,
        }));
        const distance = Number(parseAttribute(distanceText));
        const bearing = Number(parseAttribute(bearingText));
        const complete = parseAttribute(completeText) === "true";
        const speedElement = await cellularFind(".objective-speed", 2000).catch(() => null);
        const speedKmh = Number((speedElement?.text ?? "").match(/(-?[0-9]+(?:\.[0-9]+)?)\s*km\/h/i)?.[1]);
        checkpoints.push({ elapsedMs: options.routeTimeoutMs - (routeDeadline - Date.now()), distanceM: distance, bearingRad: bearing, speedKmh, complete });
        await fs.writeFile(checkpointFile, `${JSON.stringify(checkpoints, null, 2)}\n`, { mode: 0o600 });
        if (complete) break;
        if (!Number.isFinite(distance) || !Number.isFinite(bearing)) throw new Error("Route telemetry became unavailable");
        noProgress = distance >= lastDistance - 0.5 ? noProgress + 1 : 0;
        if (noProgress >= 5) {
          recoveries += 1;
          if (recoveries > 8) throw new Error(`Route remained blocked near ${Math.round(distance)}m after eight recoveries`);
          console.log(`route_recovery=${recoveries} distance_m=${Math.round(distance)}`);
          const baseEscapeSteer = bearing >= 0 ? -1 : 1;
          const escapeSteer = recoveries % 2 === 1 ? baseEscapeSteer : -baseEscapeSteer;
          await call("appium_context", { action: "switch", context: "NATIVE_APP", sessionId: nativeSessionId }, 60_000);
          await call("appium_perform_actions", {
            sessionId: nativeSessionId,
            actions: makeDriveActions({
              pedal: brake,
              pedalId: `brake-${recoveries}`,
              stick,
              steer: escapeSteer,
              durationMs: 2200,
            }),
          }, 30_000);
          await call("appium_perform_actions", {
            sessionId: nativeSessionId,
            actions: makeDriveActions({
              pedal: gas,
              pedalId: `recovery-gas-${recoveries}`,
              stick,
              steer: escapeSteer,
              durationMs: 2600,
            }),
          }, 30_000);
          await call("appium_context", { action: "switch", context: webContext, sessionId: nativeSessionId }, 60_000);
          await captureNative(`recovery-${String(recoveries).padStart(2, "0")}`);
          noProgress = 0;
          lastDistance = Number.POSITIVE_INFINITY;
          continue;
        }
        lastDistance = distance;
        const steer = Math.max(-1, Math.min(1, bearing / 0.9));
        const absoluteBearing = Math.abs(bearing);
        await call("appium_context", { action: "switch", context: "NATIVE_APP", sessionId: nativeSessionId }, 60_000);
        if ((Number.isFinite(speedKmh) && speedKmh > 28) || (absoluteBearing > 0.8 && speedKmh > 14)) {
          await call("appium_perform_actions", {
            sessionId: nativeSessionId,
            actions: makeDriveActions({ pedal: brake, pedalId: "speed-brake", stick, steer, durationMs: speedKmh > 40 ? 800 : 500 }),
          }, 30_000);
        } else {
          const gasDurationMs = absoluteBearing > 0.8 ? 550 : absoluteBearing > 0.4 ? 700 : 900;
          await call("appium_perform_actions", {
            sessionId: nativeSessionId,
            actions: makeDriveActions({ gas, stick, steer, durationMs: gasDurationMs }),
          }, 30_000);
        }
        await call("appium_context", { action: "switch", context: webContext, sessionId: nativeSessionId }, 60_000);
        if (checkpoints.length === 1 || checkpoints.length % 8 === 0) {
          await captureNative(`route-${String(checkpoints.length).padStart(3, "0")}`);
        }
      }
      if (!checkpoints.at(-1)?.complete) throw new Error("GTA Labin route did not complete before the timeout");
      await captureNative("07-route-complete");

      await call("appium_context", { action: "switch", context: "NATIVE_APP", sessionId: nativeSessionId });
      await call("appium_app_lifecycle", { action: "background", seconds: 2, sessionId: nativeSessionId }, 30_000);
      await sleep(2500, abortController.signal);
      const closed = resultJson(
        await call("iphone_browser_session", { action: "status", operationId: cellularOperationId }),
        "background close status",
      );
      if (closed.state !== "closed") throw new Error(`Backgrounding did not close the cellular session: ${closed.state}`);
      cellularSessionId = null;
      const reconnected = await waitDeviceReady(35_000);
      if (!reconnected?.secureReady) throw new Error("Bridge Browser did not reconnect after foregrounding");
      await captureNative("08-reconnected");
      console.log(`BRIDGE_BROWSER_PHYSICAL_QA_OK=1 artifact_root=${artifactRoot}`);
    },
    async () => {
      let cleanupError = null;
      if (cellularOperationId) {
        const action = cellularSessionId ? "stop" : "cancel";
        await call("iphone_browser_session", {
          action,
          operationId: cellularOperationId,
          ...(cellularSessionId ? { sessionId: cellularSessionId } : {}),
        }, 30_000).catch(() => {});
      }
      if (nativeSessionId) {
        await call("appium_session_management", { action: "delete", sessionId: nativeSessionId }, 60_000).catch(() => {});
        nativeSessionId = null;
      }
      const finalSessions = await call("appium_session_management", { action: "list" }, 30_000).catch(() => null);
      if (finalSessions && !/No active sessions found/i.test(resultText(finalSessions))) {
        cleanupError = new Error(`Physical QA cleanup left an Appium session: ${resultText(finalSessions)}`);
      }
      await assertNoLeaseDirectories(artifactRoot).catch((error) => {
        cleanupError ??= error;
      });
      if (clientConnected) await client.close().catch((error) => {
        cleanupError ??= error;
      });
      await transport.close().catch(() => {});
      if (serverStderr.trim() && process.exitCode) {
        await fs.writeFile(path.join(artifactRoot, "server-stderr.log"), serverStderr, { mode: 0o600 }).catch(() => {});
      }
      if (cleanupError) throw cleanupError;
    },
  );
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  runPhysicalQa(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
