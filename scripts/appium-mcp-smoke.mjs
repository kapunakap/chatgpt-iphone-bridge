#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcher = process.env.APPIUM_BRIDGE_LAUNCHER ?? path.join(scriptDir, "appium-mcp-current.sh");
const requiredTools = new Set([
  "select_device",
  "appium_prepare_ios_real_device",
  "appium_session_management",
  "appium_screenshot",
  "appium_orientation",
  "appium_perform_actions",
  "appium_prepare_ios_real_device_async",
  "appium_create_session_async",
]);
const cellularEnabled = process.env.IPHONE_BRIDGE_CELLULAR_ENABLED === "true";
if (cellularEnabled) {
  for (const name of [
    "iphone_browser_device_status",
    "iphone_browser_session",
    "iphone_browser_navigate",
    "iphone_browser_find",
    "iphone_browser_element",
    "iphone_browser_snapshot",
    "iphone_browser_screenshot",
  ]) {
    requiredTools.add(name);
  }
}
for (const name of (process.env.APPIUM_BRIDGE_REQUIRED_TOOLS ?? "").split(",").filter(Boolean)) {
  requiredTools.add(name);
}
const expectedToolCount = Number(process.env.APPIUM_BRIDGE_EXPECTED_TOOLS ?? (cellularEnabled ? "40" : "33"));
const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-smoke-"));

const child = spawn(launcher, [], {
  cwd: repoRoot,
  env: { ...process.env, APPIUM_BRIDGE_ARTIFACT_ROOT: artifactRoot },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 16000) stderr = stderr.slice(-16000);
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function main() {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "chatgpt-iphone-bridge-smoke", version: "0.1.0" },
  });
  if (!initialized?.serverInfo?.name) throw new Error("initialize did not return serverInfo");

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const listed = await request(2, "tools/list");
  const toolsByName = new Map((listed?.tools ?? []).map((tool) => [tool.name, tool]));
  const names = new Set((listed?.tools ?? []).map((tool) => tool.name));
  const missing = [...requiredTools].filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`Missing required Appium tools: ${missing.join(", ")}`);
  if (names.size !== expectedToolCount) {
    throw new Error(`Expected ${expectedToolCount} Appium tools, found ${names.size}`);
  }
  const createProperties = toolsByName.get("appium_create_session_async")?.inputSchema?.properties ?? {};
  if (!createProperties.clientRequestId || createProperties.clientRequestId.maxLength !== 200) {
    throw new Error("appium_create_session_async schema is missing the required clientRequestId contract");
  }

  const listedSessions = await request(3, "tools/call", {
    name: "appium_session_management",
    arguments: { action: "list" },
  });
  if (listedSessions?.isError) throw new Error("session list failed during smoke test");

  const missingOperation = await request(4, "tools/call", {
    name: "appium_create_session_async",
    arguments: { action: "status" },
  });
  if (missingOperation?.isError !== true) throw new Error("missing async operation should fail closed");
  if (missingOperation?.structuredContent?.error?.code !== "INVALID_ARGUMENTS") {
    throw new Error("async structuredContent was not preserved through plugin hooks");
  }

  console.log(`server=${initialized.serverInfo.name}`);
  console.log(`protocol=${initialized.protocolVersion}`);
  console.log(`tools=${names.size}`);
  console.log("APPIUM_MCP_SMOKE_OK=1");
}

try {
  await main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.rm(artifactRoot, { recursive: true, force: true });
}
