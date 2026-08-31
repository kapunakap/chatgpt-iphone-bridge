import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("../scripts/appium-mcp-worker-server.mjs", import.meta.url));

export async function runWorkerTool(name, args, options = {}) {
  const workerEnv = { APPIUM_BRIDGE_WORKER: "1" };
  for (const key of [
    "APPIUM_BRIDGE_ARTIFACT_ROOT",
    "DEVELOPER_DIR",
    "IOS_PROVISIONING_PROFILE_DIR",
    "TMPDIR",
  ]) {
    if (process.env[key]) workerEnv[key] = process.env[key];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [workerPath],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: workerEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "chatgpt-iphone-bridge-worker", version: "0.2.0-beta.3" });
  let stderr = "";
  transport.stderr?.setEncoding?.("utf8");
  transport.stderr?.on?.("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
  });

  try {
    await client.connect(transport);
    return await client.callTool(
      { name, arguments: args },
      undefined,
      { signal: options.signal, timeout: options.timeoutMs ?? 10 * 60_000 },
    );
  } catch (error) {
    const suffix = stderr.trim() ? `\nWorker diagnostics:\n${stderr.trim()}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
