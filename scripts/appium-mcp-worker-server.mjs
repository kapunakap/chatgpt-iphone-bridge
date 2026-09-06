#!/usr/bin/env node

import { createAppiumMcpServer } from "appium-mcp/core";

import { WdaProvisioningPlugin } from "../src/ios-wda-provisioning.mjs";

if (process.env.APPIUM_BRIDGE_WORKER !== "1") {
  throw new Error("The Appium MCP worker may only be started by the bridge lifecycle plugin");
}

const server = await createAppiumMcpServer({
  plugins: [new WdaProvisioningPlugin()],
  serverName: "Local iPhone Worker",
});
await server.start({ transportType: "stdio" });
