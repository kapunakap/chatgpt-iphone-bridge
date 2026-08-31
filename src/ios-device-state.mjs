import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export class DeviceStateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DeviceStateError";
    this.code = code;
    this.retryable = true;
  }
}

export function parseAvailableRealIphones(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s{2,}/))
    .filter((columns) => columns.length >= 5)
    .filter((columns) => columns[3] === "available (paired)" && /^iPhone\b/.test(columns.slice(4).join(" ")))
    .map((columns) => ({ name: columns[0], state: columns[3], model: columns.slice(4).join(" ") }));
}

export function parseDeviceLockState(output) {
  const match = String(output).match(/passcodeRequired:\s*(true|false)/i);
  if (!match) throw new DeviceStateError("DEVICE_STATE_UNAVAILABLE", "devicectl did not return passcodeRequired");
  return { locked: match[1].toLowerCase() === "true" };
}

export async function listAvailableRealIphones(options = {}) {
  const run = options.execFile ?? execFile;
  const { stdout } = await run("xcrun", ["devicectl", "list", "devices"], { timeout: options.timeoutMs ?? 15_000 });
  return parseAvailableRealIphones(stdout);
}

export async function assertRealIphoneUnlocked(udid, options = {}) {
  const run = options.execFile ?? execFile;
  let stdout;
  try {
    ({ stdout } = await run(
      "xcrun",
      ["devicectl", "device", "info", "lockState", "--device", udid, "--timeout", "10"],
      { timeout: options.timeoutMs ?? 15_000, signal: options.signal },
    ));
  } catch (error) {
    throw new DeviceStateError("DEVICE_STATE_UNAVAILABLE", `Unable to read iPhone lock state: ${error.message}`, {
      cause: error,
    });
  }
  const state = parseDeviceLockState(stdout);
  if (state.locked) throw new DeviceStateError("DEVICE_LOCKED", "Unlock the selected iPhone before creating Safari");
  return state;
}
