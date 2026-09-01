import {
  createAppiumMcpServer,
  formatVerificationReport,
  verifyAppiumMcpNames,
} from "appium-mcp/core";

import { AsyncSessionPlugin } from "./async-session-plugin.mjs";
import { IosSessionSafetyPlugin } from "./ios-session-safety-plugin.mjs";

const DEFAULT_INSTRUCTIONS = [
  "This server controls a local pool of USB-connected real iPhones and iPads for Safari testing.",
  "Select every target device by UDID before preparation or session creation.",
  "Use appium_prepare_ios_real_device_async start/status/cancel instead of the blocking preparation tool.",
  "Use appium_create_session_async start/status/cancel instead of appium_session_management action=create; pass udid for pool operations.",
  "When multiple operations or sessions exist, always pass operationId or sessionId.",
  "Delete every owned session when testing is complete.",
];

export async function createIphoneBridgeServer(options = {}) {
  const policyPlugin = options.policyPlugin ?? new IosSessionSafetyPlugin();
  const lifecyclePlugin = options.lifecyclePlugin ?? new AsyncSessionPlugin(options.lifecycleOptions);
  const additionalPlugins = options.plugins ?? [];
  const plugins = [policyPlugin, lifecyclePlugin, ...additionalPlugins];
  const verification = verifyAppiumMcpNames({ plugins });
  if (!verification.ok) throw new Error(formatVerificationReport(verification));

  const instructions = [
    ...DEFAULT_INSTRUCTIONS,
    ...(Array.isArray(options.additionalInstructions)
      ? options.additionalInstructions
      : options.additionalInstructions
        ? [options.additionalInstructions]
        : []),
  ].join(" ");

  const server = await createAppiumMcpServer({
    plugins,
    serverName: options.serverName ?? "Local iPhone",
    additionalInstructions: instructions,
    policy: options.policy,
  });

  return { server, lifecyclePlugin, policyPlugin, plugins, verification };
}

export async function startIphoneBridgeServer(options = {}) {
  const created = await createIphoneBridgeServer(options);
  const { server, lifecyclePlugin } = created;
  let stopping = null;

  const stop = (signal) => {
    stopping ??= (async () => {
      console.error(`Local iPhone bridge received ${signal}; cleaning up`);
      await lifecyclePlugin.shutdown();
      await server.stop();
    })().catch((error) => {
      console.error(`Local iPhone bridge shutdown failed: ${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 1;
    });
    return stopping;
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  await server.start({ transportType: "stdio" });
  return { ...created, stop };
}

export { DEFAULT_INSTRUCTIONS };
