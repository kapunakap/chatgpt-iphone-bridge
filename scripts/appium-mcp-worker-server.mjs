#!/usr/bin/env node

import { createAppiumMcpServer } from "appium-mcp/core";

if (process.env.APPIUM_BRIDGE_WORKER !== "1") {
  throw new Error("The Appium MCP worker may only be started by the bridge lifecycle plugin");
}

const server = await createAppiumMcpServer({ serverName: "Local iPhone Worker" });
await server.start({ transportType: "stdio" });
