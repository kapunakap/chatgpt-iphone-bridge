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
  const lockPath = path.join(root, "session.lock");
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ token: "stale", pid: 999_999_999, kind: "create" })}\n`,
  );
  const lease = new DeviceLease({ root, makeId: () => "new-token" });
  assert.equal(await lease.acquire("create"), "new-token");
  await lease.release();
});
