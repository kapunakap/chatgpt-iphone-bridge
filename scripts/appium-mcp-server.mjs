#!/usr/bin/env node

import {
  createAppiumMcpServer,
  formatVerificationReport,
  verifyAppiumMcpNames,
} from "appium-mcp/core";

import { IosSessionSafetyPlugin } from "./ios-session-safety-plugin.mjs";

const plugins = [new IosSessionSafetyPlugin()];
const verification = verifyAppiumMcpNames({ plugins });
if (!verification.ok) {
  console.error(formatVerificationReport(verification));
  process.exit(1);
}

const server = await createAppiumMcpServer({
  plugins,
  serverName: "Local iPhone",
  additionalInstructions: [
    "Select and prepare a real iPhone before creating a real-device WDA session.",
    "For real-device WDA sessions, an explicit appium:udid is preserved; otherwise the selected runtime iPhone is injected.",
    "Only one Appium-owned session may be active at a time.",
    "Delete the active session before creating another session or stopping the bridge.",
  ].join(" "),
});

await server.start({ transportType: "stdio" });
