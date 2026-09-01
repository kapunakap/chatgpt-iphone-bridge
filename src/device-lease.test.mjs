import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceLease } from "./device-lease.mjs";

test("device lease is exclusive and releases only for its owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new DeviceLease({ root, makeId: () => "first-token" });
  const second = new DeviceLease({ root, makeId: () => "second-token" });
  assert.equal(await first.acquire("create"), "first-token");
  await assert.rejects(second.acquire("prepare"), /already active/);
  await first.release("wrong-token");
  await assert.rejects(second.acquire("prepare"), /already active/);
  await first.release("first-token");
  assert.equal(await second.acquire("prepare"), "second-token");
  await second.release();
});

test("device lease reclaims a dead owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lease = new DeviceLease({ root, makeId: () => "new-token" });
  const lockPath = lease.lockPathFor("device-a");
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ token: "stale", pid: 999_999_999, kind: "create" })}\n`,
  );
  assert.equal(await lease.acquire("create", "device-a"), "new-token");
  await lease.release();
});

test("device leases isolate different UDIDs but exclude the same UDID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-pool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let tokenNumber = 0;
  const pool = new DeviceLease({ root, makeId: () => `pool-${++tokenNumber}` });
  const contender = new DeviceLease({ root, makeId: () => "contender" });

  const first = await pool.acquire("create", "device-a");
  const second = await pool.acquire("create", "device-b");
  assert.notEqual(first, second);
  await assert.rejects(contender.acquire("prepare", "device-a"), /already active/);

  await pool.release(first);
  assert.equal(await contender.acquire("prepare", "device-a"), "contender");
  await contender.release();
  await pool.release(second);
});
