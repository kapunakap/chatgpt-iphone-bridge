#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcher = path.join(scriptDir, "appium-mcp-current.sh");
const requiredTools = new Set([
  "select_device",
  "appium_prepare_ios_real_device",
  "appium_session_management",
  "appium_screenshot",
  "appium_orientation",
  "appium_perform_actions",
]);
const expectedToolCount = 31;

const child = spawn(launcher, [], {
  cwd: repoRoot,
  env: process.env,
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
  const names = new Set((listed?.tools ?? []).map((tool) => tool.name));
  const missing = [...requiredTools].filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`Missing required Appium tools: ${missing.join(", ")}`);
  if (names.size !== expectedToolCount) {
    throw new Error(`Expected ${expectedToolCount} Appium tools, found ${names.size}`);
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
}
