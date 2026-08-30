#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const action = process.argv[2];
if (!new Set(["install", "uninstall"]).has(action)) {
  throw new Error("Usage: runtime-monitor-service.mjs install|uninstall");
}
if (process.platform !== "darwin" && process.env.APPIUM_BRIDGE_ALLOW_NON_DARWIN_MONITOR_TEST !== "1") {
  throw new Error("Runtime monitor service requires macOS");
}

const label = "com.kapunakap.chatgpt-iphone-bridge.runtime-monitor";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const monitorScript = path.join(repoRoot, "scripts", "runtime-monitor.mjs");
const launchAgentsDir =
  process.env.APPIUM_BRIDGE_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const launchctl = process.env.APPIUM_BRIDGE_LAUNCHCTL ?? "/bin/launchctl";
const tunnelClient =
  process.env.APPIUM_BRIDGE_TUNNEL_CLIENT ??
  (await execFile("/usr/bin/which", ["tunnel-client"], { timeout: 5_000 })).stdout.trim();
if (!path.isAbsolute(tunnelClient)) throw new Error("tunnel-client must resolve to an absolute path");
const domain = `gui/${process.getuid()}`;
const artifactRoot =
  process.env.APPIUM_BRIDGE_ARTIFACT_ROOT ??
  path.join(os.homedir(), "Library", "Application Support", "chatgpt-iphone-bridge");
const logDir = path.join(artifactRoot, "logs");

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

if (action === "uninstall") {
  await execFile(launchctl, ["bootout", domain, plistPath]).catch(() => {});
  await fs.rm(plistPath, { force: true });
  console.log(`runtime_monitor_uninstalled=${plistPath}`);
  process.exit(0);
}

await fs.mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>${escapeXml(process.execPath)}</string>
<string>${escapeXml(monitorScript)}</string>
<string>check</string>
</array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>EnvironmentVariables</key><dict>
<key>APPIUM_BRIDGE_TUNNEL_CLIENT</key><string>${escapeXml(tunnelClient)}</string>
</dict>
<key>StandardOutPath</key><string>${escapeXml(path.join(logDir, "runtime-monitor.log"))}</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, "runtime-monitor-error.log"))}</string>
</dict></plist>
`;
await fs.writeFile(plistPath, plist, { mode: 0o644 });
await execFile(launchctl, ["bootout", domain, plistPath]).catch(() => {});
await execFile(launchctl, ["bootstrap", domain, plistPath]);
console.log(`runtime_monitor_installed=${plistPath}`);
