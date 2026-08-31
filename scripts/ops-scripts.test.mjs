import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stopScript = path.join(repoRoot, "scripts", "stop.sh");
const cellularLauncher = path.join(repoRoot, "scripts", "appium-mcp-cellular-current.sh");
const queueStatusScript = path.join(repoRoot, "scripts", "queue-status.mjs");
const runtimeRepairScript = path.join(repoRoot, "scripts", "runtime-repair.mjs");
const monitorServiceScript = path.join(repoRoot, "scripts", "runtime-monitor-service.mjs");
const physicalSmokeScript = path.join(repoRoot, "scripts", "physical-smoke.mjs");
const expectedLauncher = path.join(repoRoot, "scripts", "appium-mcp-current.sh");

async function fakeEnvironment(t, status, statusExit = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-ops-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.log");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "tunnel-client"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_CALLS, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("status")) {
  if (fs.existsSync(process.env.FAKE_STOPPED)) {
    process.stdout.write(JSON.stringify({ process_running: false }));
    process.exit(0);
  }
  if (Number(process.env.FAKE_STATUS_EXIT)) process.exit(Number(process.env.FAKE_STATUS_EXIT));
  process.stdout.write(process.env.FAKE_STATUS);
  process.exit(0);
}
if (process.argv.includes("list")) {
  process.stdout.write(process.env.FAKE_LIST);
  process.exit(0);
}
if (process.argv.includes("stop")) fs.writeFileSync(process.env.FAKE_STOPPED, "1");
process.exit(0);
`,
    { mode: 0o755 },
  );
  return {
    root,
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      APPIUM_BRIDGE_ARTIFACT_ROOT: path.join(root, "artifacts"),
      FAKE_CALLS: calls,
      FAKE_STATUS: JSON.stringify(status),
      FAKE_STATUS_EXIT: String(statusExit),
      FAKE_STOPPED: path.join(root, "stopped"),
      FAKE_LIST: JSON.stringify({ aliases: [] }),
    },
  };
}

test("stop is idempotent when the managed alias is absent", async (t) => {
  const fake = await fakeEnvironment(t, {}, 1);
  const result = await execFileAsync("bash", [stopScript], { env: fake.env });
  assert.match(result.stdout, /already stopped or absent/);
  const calls = await fs.readFile(fake.calls, "utf8");
  assert.doesNotMatch(calls, / stop /);
});

test("stop refuses a running alias with a different launcher", async (t) => {
  const fake = await fakeEnvironment(t, {
    process_running: true,
    process: { target_value: '"/another/launcher.sh"' },
  });
  await assert.rejects(
    execFileAsync("bash", [stopScript], { env: fake.env }),
    (error) => error.code === 1 && /different launcher/.test(error.stderr),
  );
  const calls = await fs.readFile(fake.calls, "utf8");
  assert.doesNotMatch(calls, / stop /);
});

test("stop owns and stops the cellular launcher", async (t) => {
  const fake = await fakeEnvironment(t, {
    process_running: true,
    process: { target_value: `"${cellularLauncher}"` },
  });
  const result = await execFileAsync("bash", [stopScript], { env: fake.env });
  assert.match(result.stdout, /BRIDGE_STOPPED=1/);
  const calls = await fs.readFile(fake.calls, "utf8");
  assert.match(calls, /runtimes --json stop local-iphone-bridge/);
});

test("stop fails closed when any runtime lease directory remains", async (t) => {
  const fake = await fakeEnvironment(t, {
    process_running: true,
    process: { target_value: `"${cellularLauncher}"` },
  });
  await fs.mkdir(path.join(fake.env.APPIUM_BRIDGE_ARTIFACT_ROOT, "runtime", "device-test.lock"), {
    recursive: true,
  });
  await assert.rejects(
    execFileAsync("bash", [stopScript], { env: fake.env }),
    (error) => error.code === 2 && /session lease remains/.test(error.stderr),
  );
});

test("queue status shows local handles but redacts private session inputs", async (t) => {
  const fake = await fakeEnvironment(t, {});
  const runtime = path.join(fake.env.APPIUM_BRIDGE_ARTIFACT_ROOT, "runtime");
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(
    path.join(runtime, "session-queue.json"),
    `${JSON.stringify({
      version: 1,
      savedAt: 1,
      queue: ["operation-private"],
      operations: [
        {
          id: "operation-private",
          clientRequestId: "caller-secret",
          state: "queued",
          enqueuedAt: 1,
          args: {
            capabilities: {
              "appium:udid": "private-device",
              "appium:safariInitialUrl": "https://private.example.test/",
            },
          },
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const result = await execFileAsync(process.execPath, [queueStatusScript], { env: fake.env });
  assert.match(result.stdout, /position=1 operation_id=operation-private state=queued/);
  assert.doesNotMatch(result.stdout, /caller-secret|private-device|private\.example/);
});

test("runtime repair refuses a canonical alias configured for another launcher", async (t) => {
  const fake = await fakeEnvironment(t, {
    process_running: false,
    healthy: false,
    ready: false,
    process: { target_value: '"/another/launcher.sh"' },
  });
  await assert.rejects(
    execFileAsync(process.execPath, [runtimeRepairScript], { env: fake.env }),
    (error) => /targets a different launcher/.test(error.stderr),
  );
  const calls = await fs.readFile(fake.calls, "utf8");
  assert.doesNotMatch(calls, / list/);
});

test("runtime repair uses only the canonical alias and existing tunnel ID", async (t) => {
  const fake = await fakeEnvironment(t, {
    process_running: false,
    healthy: false,
    ready: false,
    process: { target_value: `"${expectedLauncher}"` },
  });
  const keyDir = path.join(fake.env.HOME, ".config", "chatgpt-iphone-bridge");
  await fs.mkdir(keyDir, { recursive: true });
  await fs.writeFile(path.join(keyDir, "runtime-api-key"), "private", { mode: 0o600 });
  const connectCalls = path.join(fake.root, "connect.log");
  const connectScript = path.join(fake.root, "connect.sh");
  await fs.writeFile(
    connectScript,
    '#!/usr/bin/env bash\nprintf "%s %s\\n" "$TUNNEL_ALIAS" "$CONTROL_PLANE_TUNNEL_ID" >> "$FAKE_CONNECT_CALLS"\n',
    { mode: 0o755 },
  );
  const tunnelId = `tunnel_${"a".repeat(32)}`;
  const result = await execFileAsync(process.execPath, [runtimeRepairScript], {
    env: {
      ...fake.env,
      FAKE_LIST: JSON.stringify({ aliases: [{ alias: "local-iphone-bridge", tunnel_id: tunnelId }] }),
      APPIUM_BRIDGE_CONNECT_SCRIPT: connectScript,
      FAKE_CONNECT_CALLS: connectCalls,
    },
  });
  assert.match(result.stdout, /runtime_repair=completed/);
  assert.equal(await fs.readFile(connectCalls, "utf8"), `local-iphone-bridge ${tunnelId}\n`);
  const calls = await fs.readFile(fake.calls, "utf8");
  assert.match(calls, /runtimes --json status local-iphone-bridge/);
  assert.match(calls, /runtimes --json list/);
});

test("monitor service installs an alert-only 60-second LaunchAgent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-monitor-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launchAgents = path.join(root, "LaunchAgents");
  const launchctlCalls = path.join(root, "launchctl.log");
  const launchctl = path.join(root, "launchctl");
  await fs.writeFile(
    launchctl,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_CALLS"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: root,
    APPIUM_BRIDGE_ARTIFACT_ROOT: path.join(root, "artifacts"),
    APPIUM_BRIDGE_LAUNCH_AGENTS_DIR: launchAgents,
    APPIUM_BRIDGE_LAUNCHCTL: launchctl,
    APPIUM_BRIDGE_TUNNEL_CLIENT: "/fake/tunnel-client",
    APPIUM_BRIDGE_ALLOW_NON_DARWIN_MONITOR_TEST: "1",
    FAKE_LAUNCHCTL_CALLS: launchctlCalls,
  };
  await execFileAsync(process.execPath, [monitorServiceScript, "install"], { env });
  const plist = await fs.readFile(
    path.join(launchAgents, "com.kapunakap.chatgpt-iphone-bridge.runtime-monitor.plist"),
    "utf8",
  );
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, /runtime-monitor\.mjs/);
  assert.match(plist, /APPIUM_BRIDGE_TUNNEL_CLIENT/);
  assert.match(plist, /\/fake\/tunnel-client/);
  assert.doesNotMatch(plist, /KeepAlive/);
  await execFileAsync(process.execPath, [monitorServiceScript, "uninstall"], { env });
  await assert.rejects(
    fs.stat(path.join(launchAgents, "com.kapunakap.chatgpt-iphone-bridge.runtime-monitor.plist")),
    (error) => error.code === "ENOENT",
  );
});

test("physical smoke never passes an empty artifact root to the bridge", async () => {
  const source = await fs.readFile(physicalSmokeScript, "utf8");
  assert.doesNotMatch(source, /APPIUM_BRIDGE_ARTIFACT_ROOT:\s*process\.env\.APPIUM_BRIDGE_ARTIFACT_ROOT\s*\?\?/);
  assert.match(source, /transportEnvironment \? \{ env: transportEnvironment \} : \{\}/);
});
