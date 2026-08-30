#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assessRuntime, CANONICAL_RUNTIME_ALIAS, normalizeRuntimeTarget } from "../src/runtime-health.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedLauncher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");
const connectScript = process.env.APPIUM_BRIDGE_CONNECT_SCRIPT ?? path.join(repoRoot, "scripts", "connect-tunnel.sh");
const keyFile =
  process.env.CONTROL_PLANE_RUNTIME_API_KEY_FILE ??
  path.join(os.homedir(), ".config", "chatgpt-iphone-bridge", "runtime-api-key");

async function tunnelJson(args, allowFailure = false) {
  try {
    const { stdout } = await execFile("tunnel-client", args, { timeout: 15_000 });
    return JSON.parse(stdout);
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

async function main() {
  const status = await tunnelJson(["runtimes", "--json", "status", CANONICAL_RUNTIME_ALIAS], true);
  if (status) {
    const assessment = assessRuntime(status, expectedLauncher);
    if (assessment.state === "healthy") {
      console.log("runtime_repair=not_needed");
      return;
    }
    const configuredTarget = normalizeRuntimeTarget(status?.process?.target_value);
    if (configuredTarget && configuredTarget !== expectedLauncher) {
      throw new Error(`Refusing repair: ${CANONICAL_RUNTIME_ALIAS} targets a different launcher: ${configuredTarget}`);
    }
  }

  const listing = await tunnelJson(["runtimes", "--json", "list"]);
  const aliases = (listing?.aliases ?? []).filter((entry) => entry.alias === CANONICAL_RUNTIME_ALIAS);
  if (aliases.length !== 1) throw new Error(`Expected exactly one ${CANONICAL_RUNTIME_ALIAS} alias, found ${aliases.length}`);
  const tunnelId = aliases[0].tunnel_id;
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId ?? "")) throw new Error("Canonical runtime has an invalid tunnel ID");
  const keyStat = await fs.stat(keyFile);
  if (
    !keyStat.isFile() ||
    keyStat.size === 0 ||
    (keyStat.mode & 0o777) !== 0o600 ||
    keyStat.uid !== process.getuid()
  ) {
    throw new Error(`Runtime API key must be a non-empty mode-600 file: ${keyFile}`);
  }

  await execFile("bash", [connectScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TUNNEL_ALIAS: CANONICAL_RUNTIME_ALIAS,
      CONTROL_PLANE_TUNNEL_ID: tunnelId,
      CONTROL_PLANE_RUNTIME_API_KEY_FILE: keyFile,
    },
    timeout: 5 * 60_000,
  });
  console.log("runtime_repair=completed");
}

try {
  await main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
