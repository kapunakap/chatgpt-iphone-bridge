import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceLease, implicitResource } from "./device-lease.mjs";

function tokenFactory(prefix) {
  let number = 0;
  return () => `${prefix}-${++number}`;
}

test("default pool lease is exclusive and releases only for its owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new DeviceLease({ root, makeId: tokenFactory("first") });
  const second = new DeviceLease({ root, makeId: tokenFactory("second") });
  const token = await first.acquire("create");
  await assert.rejects(second.acquire("prepare"), /already active/);
  await first.release("wrong-token");
  await assert.rejects(second.acquire("prepare"), /already active/);
  await first.release(token);
  const secondToken = await second.acquire("prepare");
  await second.release(secondToken);
});

test("device lease reclaims a dead legacy global owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "session.lock");
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ token: "stale", pid: 999_999_999, kind: "create" })}\n`,
  );
  const lease = new DeviceLease({ root, makeId: tokenFactory("new") });
  const token = await lease.acquire("create", "device:a");
  await lease.release(token);
});

test("device resources isolate different UDIDs and exclude the same UDID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-pool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pool = new DeviceLease({ root, makeId: tokenFactory("pool") });
  const contender = new DeviceLease({ root, makeId: tokenFactory("contender") });

  const first = await pool.acquire("create", "device:a");
  const second = await pool.acquire("create", "device:b");
  assert.notEqual(first, second);
  await assert.rejects(contender.acquire("create", "device:a"), /already active/);

  const third = await contender.acquire("create", "device:c");
  await contender.release(third);
  await pool.release(first);
  const sameDevice = await contender.acquire("create", "device:a");
  await contender.release(sameDevice);
  await pool.release(second);
});

test("whole-pool lease conflicts with every device-specific lease", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-global-pool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const usb = new DeviceLease({ root, makeId: tokenFactory("usb") });
  const cellular = new DeviceLease({ root, makeId: tokenFactory("cellular") });

  const usbToken = await usb.acquire("create", "device:a");
  await assert.rejects(cellular.acquire("cellular_browser"), /already active/);
  await usb.release(usbToken);

  const cellularToken = await cellular.acquire("cellular_browser");
  await assert.rejects(usb.acquire("create", "device:b"), /already active/);
  await cellular.release(cellularToken);
});

test("shared WDA preparation resource serializes only preparation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-wda-pool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new DeviceLease({ root, makeId: tokenFactory("first") });
  const second = new DeviceLease({ root, makeId: tokenFactory("second") });

  const deviceA = await first.acquire("prepare", "device:a");
  const sharedWda = await first.acquire("prepare", "shared:wda-preparation");
  const deviceB = await second.acquire("create", "device:b");
  await assert.rejects(second.acquire("prepare", "shared:wda-preparation"), /already active/);

  await second.release(deviceB);
  await first.release(sharedWda);
  await first.release(deviceA);
});

test("cellular arbitration maps to one USB UDID only when configured", () => {
  const previous = process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
  try {
    delete process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
    assert.equal(implicitResource("cellular_browser"), "pool");
    process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID = "mapped-device";
    assert.equal(implicitResource("cellular_browser"), "device:mapped-device");
    assert.equal(implicitResource("create"), "pool");
  } finally {
    if (previous == null) delete process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
    else process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID = previous;
  }
});
