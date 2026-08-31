#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolName = process.argv[2];
if (!toolName) {
  console.error("Usage: printf '%s\\n' '<JSON arguments>' | npm run tool -- <tool-name>");
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let toolArguments = {};
try {
  if (input.trim()) toolArguments = JSON.parse(input);
} catch (error) {
  console.error(`Invalid JSON on stdin: ${error.message}`);
  process.exit(2);
}

if (
  toolName === "appium_prepare_ios_real_device_async" ||
  toolName === "appium_create_session_async" ||
  (toolName === "appium_session_management" && toolArguments.action !== "list")
) {
  console.error("ERROR: Stateful lifecycle tools require one persistent MCP connection; use the tunnel or a preflight script.");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcher = path.join(scriptDir, "appium-mcp-current.sh");
const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-tool-"));
const transport = new StdioClientTransport({
  command: launcher,
  cwd: repoRoot,
  env: { APPIUM_BRIDGE_ARTIFACT_ROOT: artifactRoot },
  stderr: "pipe",
});
const client = new Client({ name: "chatgpt-iphone-bridge-tool", version: "0.2.0-beta.3" });
let stderr = "";
transport.stderr?.setEncoding?.("utf8");
transport.stderr?.on?.("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
});

const abortController = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => abortController.abort());
}

try {
  await client.connect(transport);
  const result = await client.callTool(
    { name: toolName, arguments: toolArguments },
    undefined,
    { signal: abortController.signal, timeout: 15 * 60_000 },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result?.isError) process.exitCode = 1;
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await fs.rm(artifactRoot, { recursive: true, force: true });
}
