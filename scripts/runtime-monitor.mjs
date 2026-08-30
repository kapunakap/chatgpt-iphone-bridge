#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assessRuntime, CANONICAL_RUNTIME_ALIAS, monitorTransition } from "../src/runtime-health.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedLauncher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");
const artifactRoot =
  process.env.APPIUM_BRIDGE_ARTIFACT_ROOT ??
  path.join(os.homedir(), "Library", "Application Support", "chatgpt-iphone-bridge");
const runtimeDir = path.join(artifactRoot, "runtime");
const statePath = path.join(runtimeDir, "monitor-state.json");
const tunnelClient = process.env.APPIUM_BRIDGE_TUNNEL_CLIENT ?? "tunnel-client";
const action = process.argv[2] ?? "check";
if (!new Set(["check", "status"]).has(action)) throw new Error("Usage: runtime-monitor.mjs [check|status]");

async function readAssessment() {
  try {
    const { stdout } = await execFile(tunnelClient, ["runtimes", "--json", "status", CANONICAL_RUNTIME_ALIAS], {
      timeout: 15_000,
    });
    return assessRuntime(JSON.parse(stdout), expectedLauncher);
  } catch (error) {
    return {
      alias: CANONICAL_RUNTIME_ALIAS,
      state: "unhealthy",
      checks: { process_running: false, healthy: false, ready: false, target_matches: false },
      failures: ["status_unavailable"],
      target: "",
      detail: error.message,
    };
  }
}

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeDir, 0o700);
  const temporary = `${statePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, statePath);
  await fs.chmod(statePath, 0o600);
}

async function notify(transition, assessment) {
  if (process.env.APPIUM_BRIDGE_MONITOR_NOTIFY === "0" || process.platform !== "darwin") return;
  const title = "Local iPhone bridge";
  const body = transition === "recovered"
    ? "Tunnel runtime recovered."
    : `Tunnel runtime is unhealthy: ${assessment.failures.join(", ")}. Run npm run runtime:repair.`;
  await execFile("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], {
    timeout: 5_000,
  }).catch(() => {});
}

const assessment = await readAssessment();
for (const [name, ok] of Object.entries(assessment.checks)) console.log(`${name}=${ok}`);
console.log(`runtime_state=${assessment.state}`);
if (assessment.failures.length > 0) console.log(`failures=${assessment.failures.join(",")}`);

if (action === "status") {
  process.exitCode = assessment.state === "healthy" ? 0 : 2;
} else {
  const previous = await readPrevious();
  const transition = monitorTransition(previous, assessment);
  const state = { ...assessment, checkedAt: new Date().toISOString() };
  await saveState(state);
  if (transition) await notify(transition, assessment);
  if (transition) console.log(`transition=${transition}`);
}
