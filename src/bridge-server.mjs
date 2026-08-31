import {
  createAppiumMcpServer,
  formatVerificationReport,
  verifyAppiumMcpNames,
} from "appium-mcp/core";

import { AsyncSessionPlugin } from "./async-session-plugin.mjs";
import { createCellularBrowserPluginFromEnvironment } from "./cellular-browser-plugin.mjs";
import { IosSessionSafetyPlugin } from "./ios-session-safety-plugin.mjs";

const DEFAULT_INSTRUCTIONS = [
  "This server controls one locally connected real iPhone for Safari testing.",
  "Select the real iPhone before preparation or session creation.",
  "Use appium_prepare_ios_real_device_async start/status/cancel instead of the blocking preparation tool.",
  "Use appium_create_session_async start/status/cancel instead of appium_session_management action=create.",
  "Give each Safari session request a unique clientRequestId and reuse it only to retry that same request.",
  "Keep the returned operationId private, pass it on every status or cancel call, and poll queued work within ten minutes to retain its FIFO spot.",
  "Delete the owned session when testing is complete.",
];

export async function createIphoneBridgeServer(options = {}) {
  const policyPlugin = options.policyPlugin ?? new IosSessionSafetyPlugin();
  const lifecyclePlugin = options.lifecyclePlugin ?? new AsyncSessionPlugin(options.lifecycleOptions);
  const cellularEnabled = options.cellular?.enabled ?? process.env.IPHONE_BRIDGE_CELLULAR_ENABLED === "true";
  const cellularOptions = { ...(options.cellular ?? {}), ...(options.cellularOptions ?? {}) };
  const cellularPlugin =
    options.cellularPlugin ??
    (cellularEnabled ? await createCellularBrowserPluginFromEnvironment(cellularOptions) : null);
  const additionalPlugins = options.plugins ?? [];
  const plugins = [policyPlugin, lifecyclePlugin, ...(cellularPlugin ? [cellularPlugin] : []), ...additionalPlugins];
  const verification = verifyAppiumMcpNames({ plugins });
  if (!verification.ok) throw new Error(formatVerificationReport(verification));

  const instructions = [
    ...DEFAULT_INSTRUCTIONS,
    ...(cellularPlugin
      ? [
          "The optional cellular tools control a dedicated foreground Bridge Browser, not Safari or native apps.",
          "Start iphone_browser_session, ask the user to tap Approve when it returns awaiting_approval, and keep polling the same operationId for up to five minutes.",
          "Do not cancel an awaiting cellular approval merely to prove delivery or clean up; cancel only when the user explicitly asks or the approval timeout expires.",
          "Stop the cellular session when testing is complete.",
        ]
      : []),
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

  return { server, lifecyclePlugin, cellularPlugin, policyPlugin, plugins, verification };
}

export async function startIphoneBridgeServer(options = {}) {
  const created = await createIphoneBridgeServer(options);
  const { server, lifecyclePlugin, cellularPlugin } = created;
  let stopping = null;

  const stop = (signal) => {
    stopping ??= (async () => {
      console.error(`Local iPhone bridge received ${signal}; cleaning up`);
      const cleanup = await Promise.allSettled([
        lifecyclePlugin.shutdown(),
        ...(cellularPlugin ? [cellularPlugin.shutdown()] : []),
      ]);
      let serverFailure = null;
      try {
        await server.stop();
      } catch (error) {
        serverFailure = error;
      }
      const failures = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (serverFailure) failures.push(serverFailure);
      if (failures.length > 0) throw new AggregateError(failures, "one or more bridge cleanup paths failed");
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
