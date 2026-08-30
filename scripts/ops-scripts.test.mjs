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
