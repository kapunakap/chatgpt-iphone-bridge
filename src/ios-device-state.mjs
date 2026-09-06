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

export function parseAvailableRealIosDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s{2,}/))
    .filter((columns) => columns.length >= 5)
    .filter((columns) => columns[3] === "available (paired)" && /^(iPhone|iPad)\b/.test(columns.slice(4).join(" ")))
    .map((columns) => ({ name: columns[0], state: columns[3], model: columns.slice(4).join(" ") }));
}

export const parseAvailableRealIphones = parseAvailableRealIosDevices;

export function parseDeviceLockState(output) {
  const match = String(output).match(/passcodeRequired:\s*(true|false)/i);
  if (!match) throw new DeviceStateError("DEVICE_STATE_UNAVAILABLE", "devicectl did not return passcodeRequired");
  return { locked: match[1].toLowerCase() === "true" };
}

function nestedValues(value, wantedKeys, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) nestedValues(item, wantedKeys, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (wantedKeys.has(normalized)) found.push(child);
    nestedValues(child, wantedKeys, found);
  }
  return found;
}

export function parseHostAttachedRealIosDevices(output) {
  const devices = JSON.parse(String(output));
  if (!Array.isArray(devices)) throw new DeviceStateError("DEVICE_STATE_UNAVAILABLE", "xcdevice returned invalid JSON");
  const unique = new Map();
  for (const device of devices) {
    const identifier = device?.identifier;
    const platform = String(device?.platform ?? "").toLowerCase();
    const model = String(device?.modelCode ?? device?.modelName ?? device?.name ?? "");
    const interfaces = nestedValues(device, new Set(["interface", "interfacetype", "transporttype", "connectiontype"]))
      .map((value) => String(value).toLowerCase());
    const hostAttached = nestedValues(device, new Set(["hostattached"])).includes(true);
    const trustedHostAttached = nestedValues(device, new Set(["trustedhostattached"])).includes(true);
    const usbAttached = interfaces.some((value) => value === "usb" || value === "wired");
    if (
      typeof identifier === "string" &&
      identifier &&
      device.simulator !== true &&
      device.available !== false &&
      platform.includes("iphoneos") &&
      /^(iPhone|iPad)/i.test(model) &&
      (usbAttached || (hostAttached && trustedHostAttached))
    ) {
      unique.set(identifier, { udid: identifier, name: device.name ?? model });
    }
  }
  return [...unique.values()];
}

export const parseHostAttachedRealIphones = parseHostAttachedRealIosDevices;

export async function listHostAttachedRealIosDevices(options = {}) {
  const run = options.execFile ?? execFile;
  const { stdout } = await run("xcrun", ["xcdevice", "list", "--timeout=5"], {
    timeout: options.timeoutMs ?? 10_000,
  });
  return parseHostAttachedRealIosDevices(stdout);
}

export const listHostAttachedRealIphones = listHostAttachedRealIosDevices;

export async function listAvailableRealIosDevices(options = {}) {
  const run = options.execFile ?? execFile;
  const { stdout } = await run("xcrun", ["devicectl", "list", "devices"], { timeout: options.timeoutMs ?? 15_000 });
  return parseAvailableRealIosDevices(stdout);
}

export const listAvailableRealIphones = listAvailableRealIosDevices;

export async function assertRealIosDeviceUnlocked(udid, options = {}) {
  const run = options.execFile ?? execFile;
  let stdout;
  try {
    ({ stdout } = await run(
      "xcrun",
      ["devicectl", "device", "info", "lockState", "--device", udid, "--timeout", "10"],
      { timeout: options.timeoutMs ?? 15_000, signal: options.signal },
    ));
  } catch (error) {
    throw new DeviceStateError("DEVICE_STATE_UNAVAILABLE", `Unable to read iOS device lock state: ${error.message}`, {
      cause: error,
    });
  }
  const state = parseDeviceLockState(stdout);
  if (state.locked) throw new DeviceStateError("DEVICE_LOCKED", "Unlock the selected iOS device before creating Safari");
  return state;
}

export const assertRealIphoneUnlocked = assertRealIosDeviceUnlocked;
