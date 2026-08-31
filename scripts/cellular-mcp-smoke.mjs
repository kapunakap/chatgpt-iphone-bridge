#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHostIdentity, saveHostIdentity } from "../src/cellular-identity.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-cellular-smoke-"));
const identityPath = path.join(temporaryRoot, "host.json");
const identity = {
  ...createHostIdentity("smoke-phone"),
  deviceId: "11111111-1111-4111-8111-111111111111",
  peerSigningPublicKey: createHostIdentity("peer").signingPublicKey,
  authToken: Buffer.alloc(32, 7).toString("base64url"),
};
await saveHostIdentity(identityPath, identity);

const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "appium-mcp-smoke.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    IPHONE_BRIDGE_CELLULAR_ENABLED: "true",
    IPHONE_BRIDGE_CELLULAR_RELAY_URL: "https://127.0.0.1:9",
    IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE: identityPath,
  },
  stdio: "inherit",
});

const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
await fs.rm(temporaryRoot, { recursive: true, force: true });
if (exitCode !== 0) process.exit(exitCode);
console.log("CELLULAR_MCP_SMOKE_OK=1");
