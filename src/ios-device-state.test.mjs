import assert from "node:assert/strict";
import test from "node:test";

import { parseAvailableRealIphones, parseDeviceLockState } from "./ios-device-state.mjs";

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
