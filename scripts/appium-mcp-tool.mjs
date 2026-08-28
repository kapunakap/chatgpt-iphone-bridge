#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const toolName = process.argv[2];
if (!toolName) {
  console.error("Usage: printf '%s\\n' '<JSON arguments>' | node scripts/appium-mcp-tool.mjs <tool-name>");
  process.exit(2);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;

let toolArguments = {};
if (input.trim()) {
  try {
    toolArguments = JSON.parse(input);
  } catch (error) {
    console.error(`Invalid JSON on stdin: ${error.message}`);
    process.exit(2);
  }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcher = path.join(scriptDir, "appium-mcp-current.sh");
const child = spawn(launcher, [], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 32000) stderr = stderr.slice(-32000);
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

function request(id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  await request(
    1,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chatgpt-iphone-bridge-tool", version: "0.1.0" },
    },
    20000,
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const result = await request(2, "tools/call", { name: toolName, arguments: toolArguments }, 15 * 60 * 1000);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result?.isError) process.exitCode = 1;
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}
