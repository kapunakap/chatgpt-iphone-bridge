import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAvailableRealIphones,
  parseDeviceLockState,
  parseHostAttachedRealIphones,
} from "./ios-device-state.mjs";

test("device discovery uses model and state instead of the user-defined name", () => {
  const output = `Name                Hostname                          Identifier   State                Model
-----------------   --------------------------------  ---------    ------------------   -------------------------------------------
The Onin            The-Onin.coredevice.local         private      available (paired)   iPhone 14 Pro (iPhone15,2)
Onin's airpad       airpad.coredevice.local           private      available (paired)   iPad Air (5th generation) (iPad13,16)
Old phone           old.coredevice.local              private      unavailable          iPhone 12 (iPhone13,2)
`;
  assert.deepEqual(parseAvailableRealIphones(output), [
    { name: "The Onin", state: "available (paired)", model: "iPhone 14 Pro (iPhone15,2)" },
  ]);
});

test("lock-state parsing fails closed when the field is absent", () => {
  assert.deepEqual(parseDeviceLockState("passcodeRequired: false"), { locked: false });
  assert.deepEqual(parseDeviceLockState("passcodeRequired: true"), { locked: true });
  assert.throws(() => parseDeviceLockState("unknown"), /did not return passcodeRequired/);
});

test("xcdevice discovery keeps the host-attached iPhone and ignores network ghosts", () => {
  const output = JSON.stringify([
    {
      simulator: false,
      available: true,
      platform: "com.apple.platform.iphoneos",
      modelCode: "iPhone15,2",
      identifier: "usb-phone",
      name: "The Onin",
      interface: "usb",
    },
    {
      simulator: false,
      available: true,
      platform: "com.apple.platform.iphoneos",
      modelCode: "iPhone14,5",
      identifier: "network-ghost",
      name: "Old phone",
      interface: "network",
    },
    {
      simulator: true,
      available: true,
      platform: "com.apple.platform.iphonesimulator",
      modelCode: "iPhone15,2",
      identifier: "simulator",
    },
  ]);
  assert.deepEqual(parseHostAttachedRealIphones(output), [{ udid: "usb-phone", name: "The Onin" }]);
});

test("xcdevice discovery accepts explicit trusted host attachment flags", () => {
  const output = JSON.stringify([
    {
      simulator: false,
      available: true,
      platform: "com.apple.platform.iphoneos",
      modelName: "iPhone 14 Pro",
      identifier: "trusted-phone",
      connectionProperties: { HostAttached: true, TrustedHostAttached: true },
    },
  ]);
  assert.deepEqual(parseHostAttachedRealIphones(output), [{ udid: "trusted-phone", name: "iPhone 14 Pro" }]);
});
