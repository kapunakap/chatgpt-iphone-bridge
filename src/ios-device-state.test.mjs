import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAvailableRealIosDevices,
  parseAvailableRealIphones,
  parseDeviceLockState,
  parseHostAttachedRealIosDevices,
  parseHostAttachedRealIphones,
} from "./ios-device-state.mjs";

test("device discovery uses model and state instead of the user-defined name", () => {
  const output = `Name                Hostname                          Identifier   State                Model
-----------------   --------------------------------  ---------    ------------------   -------------------------------------------
The Onin            The-Onin.coredevice.local         private      available (paired)   iPhone 14 Pro (iPhone15,2)
Onin's airpad       airpad.coredevice.local           private      available (paired)   iPad Air (5th generation) (iPad13,16)
Old phone           old.coredevice.local              private      unavailable          iPhone 12 (iPhone13,2)
`;
  const expected = [
    { name: "The Onin", state: "available (paired)", model: "iPhone 14 Pro (iPhone15,2)" },
    { name: "Onin's airpad", state: "available (paired)", model: "iPad Air (5th generation) (iPad13,16)" },
  ];
  assert.deepEqual(parseAvailableRealIosDevices(output), expected);
  assert.deepEqual(parseAvailableRealIphones(output), expected);
});

test("lock-state parsing fails closed when the field is absent", () => {
  assert.deepEqual(parseDeviceLockState("passcodeRequired: false"), { locked: false });
  assert.deepEqual(parseDeviceLockState("passcodeRequired: true"), { locked: true });
  assert.throws(() => parseDeviceLockState("unknown"), /did not return passcodeRequired/);
});

test("xcdevice discovery keeps host-attached iPhone and iPad targets and ignores network ghosts", () => {
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
      modelCode: "iPad13,16",
      identifier: "usb-pad",
      name: "Airpad",
      interface: "wired",
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
  const expected = [
    { udid: "usb-phone", name: "The Onin" },
    { udid: "usb-pad", name: "Airpad" },
  ];
  assert.deepEqual(parseHostAttachedRealIosDevices(output), expected);
  assert.deepEqual(parseHostAttachedRealIphones(output), expected);
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
  assert.deepEqual(parseHostAttachedRealIosDevices(output), [{ udid: "trusted-phone", name: "iPhone 14 Pro" }]);
});
